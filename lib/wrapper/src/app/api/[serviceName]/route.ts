import { NextRequest, NextResponse } from "next/server";
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  RunTaskCommandOutput,
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
import type { StatusResponse } from "../../../lib/types";

const ecs = new ECSClient();
const autoscaling = new AutoScalingClient();

const TASK_HEALTHY_TIMEOUT_MS = 300_000;
const EC2_INSTANCE_JOIN_TIMEOUT_MS = 180_000;
const TASK_CHECK_INTERVAL_MS = 3_000;
const EC2_CAPACITY_CHECK_INTERVAL_MS = 5_000;

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

function createResponse(
  status: "ready" | "starting" | "error",
  serviceUrl: string,
  httpStatus: number = 200,
): NextResponse {
  const response: StatusResponse = {
    status: status === "error" ? "starting" : status,
    url: serviceUrl,
  };
  return NextResponse.json(response, { status: httpStatus });
}

function extractTaskArn(
  response: RunTaskCommandOutput,
  taskType: "service" | "proxy",
): string {
  const taskArn = response.tasks?.[0]?.taskArn;
  if (!taskArn) {
    const failure = response.failures?.[0];
    throw new Error(
      `Failed to launch ${taskType} task: ${failure?.reason ?? "unknown"}`,
    );
  }
  return taskArn;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ serviceName: string }> },
) {
  const { serviceName } = await params;

  const serviceUrl = `http://${serviceName}.${config.domain}:9060`;

  try {
    validateServiceName(serviceName);
  } catch (error) {
    return createResponse("error", serviceUrl, 400);
  }

  const searchParams = request.nextUrl.searchParams;
  const checkStatus = searchParams.get("status") === "true";

  try {
    const [proxyTask, serviceTask] = await Promise.all([
      findTask(config.proxyCluster, serviceName, "FARGATE"),
      findTask(config.serviceCluster, serviceName, "EC2"),
    ]);

    const proxyHealthy = proxyTask?.healthStatus === "HEALTHY";
    const serviceHealthy =
      serviceTask?.healthStatus === "HEALTHY" && !!serviceTask.privateIp;

    if (checkStatus) {
      return createResponse(
        proxyHealthy && serviceHealthy ? "ready" : "starting",
        serviceUrl,
      );
    }

    if (proxyHealthy && serviceHealthy) {
      return createResponse("ready", serviceUrl);
    }

    const lockResult = await acquireLock(serviceName);
    if (!lockResult.acquired) {
      return createResponse("starting", serviceUrl, 409);
    }

    let lockReleased = false;
    try {
      const [recheckProxy, recheckService] = await Promise.all([
        findTask(config.proxyCluster, serviceName, "FARGATE"),
        findTask(config.serviceCluster, serviceName, "EC2"),
      ]);

      if (
        recheckProxy?.healthStatus === "HEALTHY" &&
        recheckService?.healthStatus === "HEALTHY" &&
        recheckService.privateIp
      ) {
        try {
          await releaseLock(serviceName);
          lockReleased = true;
        } catch (error) {
          console.warn(`[${serviceName}] Failed to release lock:`, error);
        }
        return createResponse("ready", serviceUrl);
      }

      let serviceTaskArn = recheckService?.arn;

      if (!serviceTaskArn) {
        let retries = 0;
        const maxRetries = 3;
        while (retries <= maxRetries) {
          try {
            await ensureEc2Capacity();
            serviceTaskArn = await launchServiceTask(serviceName);
            break;
          } catch (error: any) {
            const errorMessage = error.message || "";
            if (errorMessage.includes("RESOURCE:") && retries < maxRetries) {
              retries++;
              await new Promise((resolve) => setTimeout(resolve, 10000));
              continue;
            }
            throw error;
          }
        }

        if (!serviceTaskArn) {
          throw new Error("Failed to launch service task after retries");
        }
      }

      const healthyService = await waitForTaskHealthy(
        config.serviceCluster,
        serviceName,
        "EC2",
        serviceTaskArn,
      );
      const serviceIp = healthyService.privateIp;
      if (!serviceIp) {
        throw new Error("Service task has no private IP");
      }

      let proxyTaskArn = recheckProxy?.arn;

      if (!proxyTaskArn) {
        proxyTaskArn = await launchProxyTask(serviceName, serviceIp);
      }

      await waitForTaskHealthy(
        config.proxyCluster,
        serviceName,
        "FARGATE",
        proxyTaskArn,
      );

      try {
        await releaseLock(serviceName);
        lockReleased = true;
      } catch (error) {
        console.warn(`[${serviceName}] Failed to release lock:`, error);
      }

      return createResponse("ready", serviceUrl);
    } finally {
      if (!lockReleased) {
        await releaseLock(serviceName).catch(() => {});
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

    return createResponse("error", serviceUrl, 500);
  }
}

interface TaskInfo {
  arn: string;
  healthStatus?: string;
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
        healthStatus: task.healthStatus,
        privateIp,
      };
    }
  }

  return null;
}

async function waitForTaskHealthy(
  cluster: string,
  serviceName: string,
  launchType: "FARGATE" | "EC2",
  taskArn: string,
  timeoutMs: number = TASK_HEALTHY_TIMEOUT_MS,
): Promise<TaskInfo> {
  await pWaitFor(
    async () => {
      const found = await findTask(cluster, serviceName, launchType);
      const normalizeArn = (arn: string) => arn.trim();
      if (
        found &&
        normalizeArn(found.arn) === normalizeArn(taskArn) &&
        found.healthStatus === "HEALTHY"
      ) {
        if (launchType === "EC2" && !found.privateIp) {
          return false;
        }
        return true;
      }
      return false;
    },
    {
      interval: TASK_CHECK_INTERVAL_MS,
      timeout: timeoutMs,
    },
  );

  const task = await findTask(cluster, serviceName, launchType);
  if (!task || task.healthStatus !== "HEALTHY") {
    throw new Error(
      `Timeout waiting for ${launchType} task ${taskArn} to be HEALTHY`,
    );
  }

  return task;
}

async function ensureEc2Capacity(): Promise<void> {
  const instances = await ecs.send(
    new ListContainerInstancesCommand({ cluster: config.serviceCluster }),
  );

  if ((instances.containerInstanceArns?.length ?? 0) > 0) {
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

  return extractTaskArn(response, "service");
}

async function launchProxyTask(
  serviceName: string,
  serviceIp: string,
): Promise<string> {
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

  return extractTaskArn(response, "proxy");
}
