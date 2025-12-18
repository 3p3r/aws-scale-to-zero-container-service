import { NextRequest, NextResponse } from "next/server";
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  ListContainerInstancesCommand,
  DescribeContainerInstancesCommand,
} from "@aws-sdk/client-ecs";
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  SetDesiredCapacityCommand,
} from "@aws-sdk/client-auto-scaling";
import { acquireLock, releaseLock } from "../../../lib/lock";
import pWaitFor from "p-wait-for";

const ecs = new ECSClient({});
const autoscaling = new AutoScalingClient({});

// Timeout constants (in milliseconds)
const TASK_RUNNING_TIMEOUT_MS = 300_000; // 5 minutes - time to wait for task to reach RUNNING
const PROXY_ACCESSIBLE_TIMEOUT_MS = 90_000; // 90 seconds - DNS propagation + service startup
const EC2_INSTANCE_JOIN_TIMEOUT_MS = 180_000; // 3 minutes - time for EC2 instance to join cluster
const TASK_CHECK_INTERVAL_MS = 3_000; // 3 seconds - interval between task status checks
const PROXY_CHECK_INTERVAL_MS = 2_000; // 2 seconds - interval between proxy accessibility checks
const EC2_CAPACITY_CHECK_INTERVAL_MS = 5_000; // 5 seconds - interval between capacity checks

const config = {
  proxyCluster: process.env.PROXY_CLUSTER!,
  serviceCluster: process.env.SERVICE_CLUSTER!,
  proxyTaskDefinition: process.env.PROXY_TASK_DEFINITION!,
  serviceTaskDefinition: process.env.SERVICE_TASK_DEFINITION!,
  proxySubnetIds: (process.env.PROXY_SUBNET_IDS || "").split(","),
  serviceSubnetIds: (process.env.SERVICE_SUBNET_IDS || "").split(","),
  securityGroupId: process.env.SECURITY_GROUP_ID!,
  asgName: process.env.SERVICE_ASG_NAME!,
  proxyContainerName: process.env.PROXY_CONTAINER_NAME || "proxy",
  serviceContainerName: process.env.SERVICE_CONTAINER_NAME || "service",
  domain: process.env.DOMAIN || "example.com",
};

// --- Route Handler ---

// Validate service name to prevent injection attacks
// Service name must be DNS-safe: alphanumeric and hyphens only, 1-63 chars
const SERVICE_NAME_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

function validateServiceName(serviceName: string): void {
  if (!serviceName || serviceName.length === 0) {
    throw new Error("Service name is required");
  }
  if (serviceName.length > 63) {
    throw new Error("Service name must be 63 characters or less");
  }
  if (!SERVICE_NAME_REGEX.test(serviceName)) {
    throw new Error(
      "Service name must contain only alphanumeric characters and hyphens, and start/end with alphanumeric",
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ serviceName: string }> },
) {
  const { serviceName } = await params;

  // Validate service name to prevent injection
  try {
    validateServiceName(serviceName);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Invalid service name",
        status: "error",
      },
      { status: 400 },
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const checkStatus = searchParams.get("status") === "true";
  const serviceUrl = `http://${serviceName}.${config.domain}:9060`;

  try {
    // Check for existing tasks
    const [proxyTask, serviceTask] = await Promise.all([
      findTask(config.proxyCluster, serviceName, "FARGATE"),
      findTask(config.serviceCluster, serviceName, "EC2"),
    ]);

    const proxyRunning = proxyTask?.status === "RUNNING";
    const serviceRunning =
      serviceTask?.status === "RUNNING" && !!serviceTask.privateIp;

    // Status check - just return current state
    if (checkStatus) {
      let isAccessible = false;
      if (proxyRunning && serviceRunning) {
        isAccessible = await checkProxyAccessible(serviceName);
      }

      return NextResponse.json({
        status: isAccessible ? "ready" : "starting",
        proxyRunning,
        serviceRunning,
        proxyTask: proxyTask?.arn,
        serviceTask: serviceTask?.arn,
        serviceIp: serviceTask?.privateIp,
        url: serviceUrl,
        isAccessible,
      });
    }

    // If both running and accessible, return immediately
    if (proxyRunning && serviceRunning) {
      const isAccessible = await checkProxyAccessible(serviceName);
      if (isAccessible) {
        return NextResponse.json({
          status: "ready",
          proxyRunning: true,
          serviceRunning: true,
          proxyTask: proxyTask?.arn,
          serviceTask: serviceTask?.arn,
          serviceIp: serviceTask?.privateIp,
          url: serviceUrl,
          isAccessible: true,
        });
      }
    }

    // Try to acquire lock - if we can't, reject the request
    const lockResult = await acquireLock(serviceName);
    if (!lockResult.acquired) {
      return NextResponse.json(
        {
          status: "starting",
          message: lockResult.reason || "Service launch in progress",
          proxyRunning: false,
          serviceRunning: false,
          url: serviceUrl,
          isAccessible: false,
        },
        { status: 409 }, // Conflict
      );
    }

    // We have the lock - proceed with launch
    let lockReleased = false;
    try {
      // Recheck tasks after acquiring lock (another request might have launched them)
      const [recheckProxy, recheckService] = await Promise.all([
        findTask(config.proxyCluster, serviceName, "FARGATE"),
        findTask(config.serviceCluster, serviceName, "EC2"),
      ]);

      if (recheckProxy && recheckService && recheckService.privateIp) {
        // Tasks already exist, release lock immediately and return
        console.log(`[${serviceName}] Tasks already exist, releasing lock...`);
        try {
          await releaseLock(serviceName);
          lockReleased = true;
        } catch (error) {
          console.warn(`[${serviceName}] Failed to release lock:`, error);
        }
        return NextResponse.json({
          status: "ready",
          proxyRunning: true,
          serviceRunning: true,
          proxyTask: recheckProxy.arn,
          serviceTask: recheckService.arn,
          serviceIp: recheckService.privateIp,
          url: serviceUrl,
          isAccessible: await checkProxyAccessible(serviceName),
        });
      }

      // Launch service task if needed
      let serviceIp = recheckService?.privateIp;
      let serviceTaskArn = recheckService?.arn;

      if (!serviceTaskArn || !serviceIp) {
        console.log(`[${serviceName}] Launching service task...`);

        // Ensure capacity and retry on resource errors
        let retries = 0;
        const maxRetries = 3;
        while (retries <= maxRetries) {
          try {
            await ensureEc2Capacity();
            serviceTaskArn = await launchServiceTask(serviceName);
            break; // Success, exit retry loop
          } catch (error: any) {
            const errorMessage = error.message || "";
            // Check if it's a resource error (memory, CPU, etc.)
            if (errorMessage.includes("RESOURCE:") && retries < maxRetries) {
              retries++;
              console.log(
                `[${serviceName}] Resource error (attempt ${retries}/${maxRetries}), scaling up and retrying...`,
              );
              // Wait a bit before retrying to allow instance to join
              await new Promise((resolve) => setTimeout(resolve, 10000));
              continue;
            }
            // Not a resource error or max retries reached, throw
            throw error;
          }
        }

        if (!serviceTaskArn) {
          throw new Error("Failed to launch service task after retries");
        }

        // Wait for service to be RUNNING and get IP
        const runningService = await waitForTaskRunning(
          config.serviceCluster,
          serviceName,
          "EC2",
          serviceTaskArn,
        );
        serviceIp = runningService.privateIp;
        serviceTaskArn = runningService.arn;
      }

      if (!serviceIp) {
        throw new Error("Service task has no private IP");
      }

      // Launch proxy task if needed
      let proxyTaskArn = recheckProxy?.arn;

      if (!proxyTaskArn) {
        console.log(
          `[${serviceName}] Launching proxy task with service IP ${serviceIp}...`,
        );
        proxyTaskArn = await launchProxyTask(serviceName, serviceIp);

        // Wait for proxy to be RUNNING
        await waitForTaskRunning(
          config.proxyCluster,
          serviceName,
          "FARGATE",
          proxyTaskArn,
        );
      }

      // Both containers are now launched and running - release lock immediately
      // to prevent deadlocks if Lambda times out during accessibility check
      console.log(
        `[${serviceName}] Both containers launched successfully, releasing lock...`,
      );
      try {
        await releaseLock(serviceName);
        lockReleased = true;
      } catch (error) {
        console.warn(`[${serviceName}] Failed to release lock:`, error);
      }

      // Wait for service to be accessible via DNS
      // DNS propagation typically takes 10-30 seconds for Route53
      // We wait up to 90 seconds to account for propagation delays
      await waitForProxyAccessible(serviceName, PROXY_ACCESSIBLE_TIMEOUT_MS);

      return NextResponse.json({
        status: "ready",
        proxyRunning: true,
        serviceRunning: true,
        proxyTask: proxyTaskArn,
        serviceTask: serviceTaskArn,
        serviceIp,
        url: serviceUrl,
        isAccessible: true,
      });
    } finally {
      // Safety net: release lock if it wasn't already released
      // (This handles error cases where containers weren't successfully launched)
      if (!lockReleased) {
        await releaseLock(serviceName).catch(() => {
          // Ignore errors - lock might have expired or been released already
        });
      }
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    const errorStack = error instanceof Error ? error.stack : undefined;

    console.error(`[${serviceName}] Error:`, {
      message: errorMessage,
      stack: errorStack,
      serviceName,
      error,
    });

    // Always try to release lock on error
    await releaseLock(serviceName).catch((releaseError) => {
      console.warn(
        `[${serviceName}] Failed to release lock after error:`,
        releaseError,
      );
    });

    return NextResponse.json(
      {
        error: errorMessage,
        status: "error",
        serviceName, // Include serviceName in error response for debugging
      },
      { status: 500 },
    );
  }
}

// --- Helper Functions ---

interface TaskInfo {
  arn: string;
  status: string;
  privateIp?: string;
}

async function findTask(
  cluster: string,
  serviceName: string,
  launchType: "FARGATE" | "EC2",
): Promise<TaskInfo | null> {
  const [running, pending] = await Promise.all([
    ecs.send(new ListTasksCommand({ cluster, desiredStatus: "RUNNING" })),
    ecs.send(new ListTasksCommand({ cluster, desiredStatus: "PENDING" })),
  ]);

  const taskArns = [...(running.taskArns ?? []), ...(pending.taskArns ?? [])];
  if (taskArns.length === 0) return null;

  // DescribeTasksCommand has a limit of 100 tasks per call
  // If we have more, we need to batch them
  const BATCH_SIZE = 100;
  const allTasks = [];

  for (let i = 0; i < taskArns.length; i += BATCH_SIZE) {
    const batch = taskArns.slice(i, i + BATCH_SIZE);
    const described = await ecs.send(
      new DescribeTasksCommand({ cluster, tasks: batch }),
    );
    if (described.tasks) {
      allTasks.push(...described.tasks);
    }
  }

  for (const task of allTasks) {
    if (task.launchType !== launchType) continue;
    if (task.lastStatus === "STOPPED" || task.lastStatus === "DEPROVISIONING") {
      continue;
    }

    // Check startedBy or environment variable
    // Validate serviceName to prevent matching wrong tasks
    const isOurTask =
      (task.startedBy?.startsWith(`wrapper-${serviceName}`) &&
        SERVICE_NAME_REGEX.test(serviceName)) ||
      task.overrides?.containerOverrides
        ?.flatMap((c) => c.environment ?? [])
        .some(
          (e) =>
            e.name === "SERVICE_NAME" &&
            e.value === serviceName &&
            SERVICE_NAME_REGEX.test(serviceName),
        );

    if (isOurTask) {
      let privateIp: string | undefined;

      // Get IP from attachments (Fargate)
      for (const attachment of task.attachments || []) {
        if (attachment.status === "ATTACHED") {
          const ip = attachment.details?.find(
            (d) => d.name === "privateIPv4Address",
          );
          if (ip?.value) {
            privateIp = ip.value;
            break;
          }
        }
      }

      // Get IP from containers (EC2)
      if (!privateIp) {
        for (const container of task.containers || []) {
          if (container.networkInterfaces?.[0]?.privateIpv4Address) {
            privateIp = container.networkInterfaces[0].privateIpv4Address;
            break;
          }
        }
      }

      return {
        arn: task.taskArn ?? "",
        status: task.lastStatus ?? "UNKNOWN",
        privateIp,
      };
    }
  }

  return null;
}

async function waitForTaskRunning(
  cluster: string,
  serviceName: string,
  launchType: "FARGATE" | "EC2",
  taskArn: string,
  timeoutMs: number = TASK_RUNNING_TIMEOUT_MS,
): Promise<TaskInfo> {
  const requirePrivateIp = launchType === "EC2";

  await pWaitFor(
    async () => {
      const found = await findTask(cluster, serviceName, launchType);
      // Normalize ARNs for comparison (trim whitespace, ensure full ARN format)
      const normalizeArn = (arn: string) => arn.trim();
      if (found && normalizeArn(found.arn) === normalizeArn(taskArn)) {
        if (
          found.status === "RUNNING" &&
          (!requirePrivateIp || found.privateIp)
        ) {
          return true; // Condition met - task is running
        }
        console.log(
          `[${serviceName}] Waiting for ${launchType} task ${taskArn} (status: ${found.status})`,
        );
      } else {
        console.log(
          `[${serviceName}] Waiting for ${launchType} task ${taskArn} to appear...`,
        );
      }
      return false; // Condition not met - keep waiting
    },
    {
      interval: TASK_CHECK_INTERVAL_MS,
      timeout: timeoutMs,
    },
  );

  // After condition is met, fetch the task one more time to return it
  const task = await findTask(cluster, serviceName, launchType);
  if (!task) {
    throw new Error(
      `Timeout waiting for ${launchType} task ${taskArn} to be RUNNING`,
    );
  }

  return task;
}

async function checkProxyAccessible(serviceName: string): Promise<boolean> {
  // Validate serviceName to prevent injection (should already be validated, but double-check)
  if (!SERVICE_NAME_REGEX.test(serviceName)) {
    console.warn(
      `[${serviceName}] Invalid service name format in checkProxyAccessible`,
    );
    return false;
  }

  const url = `http://${serviceName}.${config.domain}:9060/health`;
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch (error) {
    // Log error for debugging but don't expose to caller
    console.debug(`[${serviceName}] Proxy accessibility check failed:`, error);
    return false;
  }
}

async function waitForProxyAccessible(
  serviceName: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await pWaitFor(
      async () => {
        return await checkProxyAccessible(serviceName);
      },
      {
        interval: PROXY_CHECK_INTERVAL_MS,
        timeout: timeoutMs,
      },
    );
    console.log(
      `[${serviceName}] Proxy is now accessible via DNS after waiting for propagation`,
    );
  } catch (error) {
    // DNS propagation can take 10-60 seconds for Route53
    // This is expected and the service may still work via direct IP
    console.warn(
      `[${serviceName}] Proxy not accessible via DNS after ${timeoutMs}ms (DNS may still be propagating)`,
    );
  }
}

async function ensureEc2Capacity(): Promise<void> {
  const instances = await ecs.send(
    new ListContainerInstancesCommand({ cluster: config.serviceCluster }),
  );

  if ((instances.containerInstanceArns?.length ?? 0) > 0) {
    // Check if any instance has capacity
    const described = await ecs.send(
      new DescribeContainerInstancesCommand({
        cluster: config.serviceCluster,
        containerInstances: instances.containerInstanceArns,
      }),
    );

    const hasCapacity = described.containerInstances?.some((ci) => {
      const cpu = ci.remainingResources?.find((r) => r.name === "CPU");
      const memory = ci.remainingResources?.find((r) => r.name === "MEMORY");
      return (
        (cpu?.integerValue ?? 0) >= 256 && (memory?.integerValue ?? 0) >= 512
      );
    });

    if (hasCapacity) {
      return;
    }
  }

  // Scale up ASG
  const asgDesc = await autoscaling.send(
    new DescribeAutoScalingGroupsCommand({
      AutoScalingGroupNames: [config.asgName],
    }),
  );

  const currentDesired = asgDesc.AutoScalingGroups?.[0]?.DesiredCapacity ?? 0;
  const maxSize = asgDesc.AutoScalingGroups?.[0]?.MaxSize ?? 1;
  const newDesired = Math.min(currentDesired + 1, maxSize);

  if (newDesired > currentDesired) {
    await autoscaling.send(
      new SetDesiredCapacityCommand({
        AutoScalingGroupName: config.asgName,
        DesiredCapacity: newDesired,
      }),
    );
  }

  // Wait for instance to join cluster
  try {
    await pWaitFor(
      async () => {
        const check = await ecs.send(
          new ListContainerInstancesCommand({
            cluster: config.serviceCluster,
          }),
        );
        return (check.containerInstanceArns?.length ?? 0) > 0;
      },
      {
        interval: EC2_CAPACITY_CHECK_INTERVAL_MS,
        timeout: EC2_INSTANCE_JOIN_TIMEOUT_MS,
      },
    );
  } catch (error) {
    throw new Error("Timeout waiting for EC2 instance to join cluster");
  }
}

async function launchServiceTask(serviceName: string): Promise<string> {
  // Validate serviceName again before using in startedBy tag
  if (!SERVICE_NAME_REGEX.test(serviceName)) {
    throw new Error(`Invalid service name: ${serviceName}`);
  }

  const response = await ecs.send(
    new RunTaskCommand({
      cluster: config.serviceCluster,
      taskDefinition: config.serviceTaskDefinition,
      launchType: "EC2",
      count: 1,
      startedBy: `wrapper-${serviceName}`,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: config.serviceSubnetIds,
          securityGroups: [config.securityGroupId],
          assignPublicIp: "DISABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: config.serviceContainerName,
            environment: [
              { name: "SERVICE_NAME", value: serviceName },
              { name: "DOMAIN", value: config.domain },
            ],
          },
        ],
      },
    }),
  );

  const taskArn = response.tasks?.[0]?.taskArn;
  if (!taskArn) {
    const failure = response.failures?.[0];
    throw new Error(
      `Failed to launch service task: ${failure?.reason ?? "unknown"}`,
    );
  }

  return taskArn;
}

async function launchProxyTask(
  serviceName: string,
  serviceIp: string,
): Promise<string> {
  // Validate inputs
  if (!SERVICE_NAME_REGEX.test(serviceName)) {
    throw new Error(`Invalid service name: ${serviceName}`);
  }
  if (!serviceIp || !/^\d+\.\d+\.\d+\.\d+$/.test(serviceIp)) {
    throw new Error(`Invalid service IP: ${serviceIp}`);
  }

  const response = await ecs.send(
    new RunTaskCommand({
      cluster: config.proxyCluster,
      taskDefinition: config.proxyTaskDefinition,
      launchType: "FARGATE",
      count: 1,
      startedBy: `wrapper-${serviceName}`,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: config.proxySubnetIds,
          securityGroups: [config.securityGroupId],
          assignPublicIp: "ENABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: config.proxyContainerName,
            environment: [
              { name: "SERVICE_NAME", value: serviceName },
              { name: "UPSTREAM_HOST", value: serviceIp },
              { name: "UPSTREAM_PORT", value: "9050" },
            ],
          },
        ],
      },
    }),
  );

  const taskArn = response.tasks?.[0]?.taskArn;
  if (!taskArn) {
    const failure = response.failures?.[0];
    throw new Error(
      `Failed to launch proxy task: ${failure?.reason ?? "unknown"}`,
    );
  }

  return taskArn;
}
