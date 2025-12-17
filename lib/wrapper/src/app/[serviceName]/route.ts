import { NextRequest, NextResponse } from "next/server";
import {
  ECSClient,
  ListTasksCommand,
  ListContainerInstancesCommand,
  DescribeContainerInstancesCommand,
  DescribeTasksCommand,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  SetDesiredCapacityCommand,
} from "@aws-sdk/client-auto-scaling";
import { backOff } from "exponential-backoff";

// --- Config ---

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function envInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  return value ? parseInt(value, 10) : defaultValue;
}

const config = {
  proxyCluster: requireEnv("PROXY_CLUSTER"),
  serviceCluster: requireEnv("SERVICE_CLUSTER"),
  proxyTaskDefinition: requireEnv("PROXY_TASK_DEFINITION"),
  serviceTaskDefinition: requireEnv("SERVICE_TASK_DEFINITION"),
  securityGroupId: requireEnv("SECURITY_GROUP_ID"),
  serviceAsgName: requireEnv("SERVICE_ASG_NAME"),
  proxyContainerName: requireEnv("PROXY_CONTAINER_NAME"),
  serviceContainerName: requireEnv("SERVICE_CONTAINER_NAME"),
  proxySubnetIds: requireEnv("PROXY_SUBNET_IDS").split(","),
  serviceSubnetIds: requireEnv("SERVICE_SUBNET_IDS").split(","),
  pollInterval: envInt("POLL_INTERVAL_MS", 2_000),
  capacityWaitTimeout: envInt("CAPACITY_WAIT_TIMEOUT_MS", 300_000),
  maxTasksPerInstance: envInt("MAX_TASKS_PER_INSTANCE", 3),
  scaleUpWaitTime: envInt("SCALE_UP_WAIT_TIME_MS", 10_000),
};

const ecs = new ECSClient();
const autoscaling = new AutoScalingClient();

// --- Route Handler ---

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ serviceName: string }> },
) {
  const { serviceName } = await params;

  try {
    // Check if tasks already exist
    const [proxyTask, serviceTask] = await Promise.all([
      findTask(config.proxyCluster, serviceName, "FARGATE"),
      findTask(config.serviceCluster, serviceName, "EC2"),
    ]);

    if (proxyTask && serviceTask) {
      return NextResponse.json({
        message: `Service ${serviceName} already running`,
        proxyTask,
        serviceTask,
      });
    }

    // Launch missing tasks
    let proxy = proxyTask;
    if (!proxy) {
      // Double-check for existing task before launching (prevent race conditions)
      const existingProxyTask = await findTask(
        config.proxyCluster,
        serviceName,
        "FARGATE",
      );
      if (existingProxyTask) {
        console.log(
          `[${serviceName}] Proxy task already exists (race condition detected): ${existingProxyTask}`,
        );
        proxy = existingProxyTask;
      } else {
        proxy = await launchProxyTask(serviceName);
      }
    }

    let service = serviceTask;
    if (!service) {
      console.log(
        `[${serviceName}] Ensuring EC2 capacity before launching service task`,
      );
      await ensureEc2Capacity();

      // Double-check for existing task before launching (prevent race conditions)
      const existingServiceTask = await findTask(
        config.serviceCluster,
        serviceName,
        "EC2",
      );
      if (existingServiceTask) {
        console.log(
          `[${serviceName}] Service task already exists (race condition detected): ${existingServiceTask}`,
        );
        service = existingServiceTask;
      } else {
        console.log(
          `[${serviceName}] EC2 capacity ensured, launching service task`,
        );
        service = await launchServiceTask(serviceName);
      }
    }

    return NextResponse.json({
      message: `Service ${serviceName} launched`,
      proxyTask: proxy,
      serviceTask: service,
    });
  } catch (error) {
    console.error("Error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// --- Task Discovery ---

async function findTask(
  cluster: string,
  serviceName: string,
  launchType: "FARGATE" | "EC2",
): Promise<string | null> {
  const [running, pending] = await Promise.all([
    ecs.send(new ListTasksCommand({ cluster, desiredStatus: "RUNNING" })),
    ecs.send(new ListTasksCommand({ cluster, desiredStatus: "PENDING" })),
  ]);

  const taskArns = [...(running.taskArns ?? []), ...(pending.taskArns ?? [])];
  if (taskArns.length === 0) return null;

  const described = await ecs.send(
    new DescribeTasksCommand({ cluster, tasks: taskArns }),
  );

  for (const task of described.tasks ?? []) {
    if (task.launchType !== launchType) continue;
    if (task.lastStatus === "STOPPED" || task.lastStatus === "DEPROVISIONING") {
      continue;
    }

    const env = task.overrides?.containerOverrides
      ?.flatMap((c) => c.environment ?? [])
      .find((e) => e.name === "SERVICE_NAME");

    if (env?.value === serviceName) {
      return task.taskArn ?? null;
    }
  }

  return null;
}

// --- Task Launching ---

async function launchProxyTask(serviceName: string): Promise<string> {
  const response = await ecs.send(
    new RunTaskCommand({
      cluster: config.proxyCluster,
      taskDefinition: config.proxyTaskDefinition,
      launchType: "FARGATE",
      count: 1,
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
            environment: [{ name: "SERVICE_NAME", value: serviceName }],
          },
        ],
      },
    }),
  );

  const taskArn = response.tasks?.[0]?.taskArn;
  if (!taskArn) throw new Error("Failed to launch proxy task");
  return taskArn;
}

async function launchServiceTask(serviceName: string): Promise<string> {
  const startTime = Date.now();
  const maxDuration = 5 * 60 * 1000; // 5 minutes
  let attemptCount = 0;
  let hasScaledUp = false;

  return backOff(
    async () => {
      attemptCount++;
      // Check if we've exceeded 5 minutes
      if (Date.now() - startTime > maxDuration) {
        throw new Error("Timeout: Exceeded 5 minute retry limit");
      }

      // Check for existing task before each attempt (prevent duplicates from concurrent requests)
      const existingTask = await findTask(
        config.serviceCluster,
        serviceName,
        "EC2",
      );
      if (existingTask) {
        console.log(
          `[${serviceName}] Found existing service task during retry: ${existingTask}`,
        );
        return existingTask;
      }

      console.log(
        `[${serviceName}] Attempting to launch EC2 service task (attempt ${attemptCount})`,
      );

      const response = await ecs.send(
        new RunTaskCommand({
          cluster: config.serviceCluster,
          taskDefinition: config.serviceTaskDefinition,
          launchType: "EC2",
          count: 1,
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
                environment: [{ name: "SERVICE_NAME", value: serviceName }],
              },
            ],
          },
        }),
      );

      const taskArn = response.tasks?.[0]?.taskArn;
      if (taskArn) {
        console.log(
          `[${serviceName}] Successfully launched EC2 service task: ${taskArn}`,
        );
        return taskArn;
      }

      const failure = response.failures?.[0];
      const reason = failure?.reason ?? "unknown";

      // If we get a resource error (CPU/MEMORY), scale up and wait
      if (
        reason.startsWith("RESOURCE:") &&
        !hasScaledUp &&
        attemptCount < 10 // Only scale up in first 10 attempts
      ) {
        console.log(
          `[${serviceName}] Resource constraint detected (${reason}), scaling up ASG`,
        );
        hasScaledUp = true;
        await scaleUpForResource();
        // Wait for new instance to be ready
        await new Promise((r) => setTimeout(r, config.scaleUpWaitTime));
      }

      const errorMessage = `Failed to launch service task: ${reason} (arn: ${failure?.arn ?? "N/A"})`;
      console.error(`[${serviceName}] ${errorMessage}`);
      throw new Error(errorMessage);
    },
    {
      numOfAttempts: 100, // High number, but we'll stop after 5 minutes
      startingDelay: 2_000,
      timeMultiple: 2,
      maxDelay: 30_000, // Max 30 seconds between retries
      jitter: "full",
      retry: (error) => {
        // Always retry unless we've exceeded time limit
        const msg = error instanceof Error ? error.message : "";
        if (msg.includes("Timeout: Exceeded 5 minute retry limit")) {
          return false;
        }
        console.log(`[${serviceName}] Retrying after error: ${msg}`);
        return true;
      },
    },
  );
}

async function scaleUpForResource(): Promise<void> {
  const asg = await getAsg();
  const currentCapacity = asg.DesiredCapacity ?? 0;
  const newCapacity = currentCapacity + 1;

  console.log(
    `Scaling up ASG from ${currentCapacity} to ${newCapacity} instances`,
  );

  await autoscaling.send(
    new SetDesiredCapacityCommand({
      AutoScalingGroupName: config.serviceAsgName,
      DesiredCapacity: newCapacity,
      HonorCooldown: false,
    }),
  );
}

// --- EC2 Capacity ---

async function ensureEc2Capacity(): Promise<void> {
  // Check if we have a ready instance
  if (await hasReadyContainerInstance()) {
    // Check if we need to scale up based on current task count
    const currentTasks = await getCurrentTaskCount();
    const instances = await getContainerInstanceCount();
    const requiredInstances = Math.ceil(
      (currentTasks + 1) / config.maxTasksPerInstance,
    );

    if (requiredInstances > instances) {
      console.log(
        `Scaling up: ${currentTasks} tasks, ${instances} instances, need ${requiredInstances} instances`,
      );
      const asg = await getAsg();
      await autoscaling.send(
        new SetDesiredCapacityCommand({
          AutoScalingGroupName: config.serviceAsgName,
          DesiredCapacity: requiredInstances,
          HonorCooldown: false,
        }),
      );
      // Wait a bit for new instances to start
      await new Promise((r) => setTimeout(r, config.scaleUpWaitTime));
    }
    return;
  }

  // No instances, scale up
  const asg = await getAsg();
  if ((asg.DesiredCapacity ?? 0) === 0) {
    await autoscaling.send(
      new SetDesiredCapacityCommand({
        AutoScalingGroupName: config.serviceAsgName,
        DesiredCapacity: 1,
        HonorCooldown: false,
      }),
    );
  }

  await waitForContainerInstance();
}

async function getCurrentTaskCount(): Promise<number> {
  const [running, pending] = await Promise.all([
    ecs.send(
      new ListTasksCommand({
        cluster: config.serviceCluster,
        desiredStatus: "RUNNING",
      }),
    ),
    ecs.send(
      new ListTasksCommand({
        cluster: config.serviceCluster,
        desiredStatus: "PENDING",
      }),
    ),
  ]);
  return (running.taskArns?.length ?? 0) + (pending.taskArns?.length ?? 0);
}

async function getContainerInstanceCount(): Promise<number> {
  const list = await ecs.send(
    new ListContainerInstancesCommand({ cluster: config.serviceCluster }),
  );
  if (!list.containerInstanceArns?.length) return 0;

  const details = await ecs.send(
    new DescribeContainerInstancesCommand({
      cluster: config.serviceCluster,
      containerInstances: list.containerInstanceArns,
    }),
  );

  return (details.containerInstances ?? []).filter(
    (i) => i.status === "ACTIVE" && i.agentConnected === true,
  ).length;
}

async function hasReadyContainerInstance(): Promise<boolean> {
  const list = await ecs.send(
    new ListContainerInstancesCommand({ cluster: config.serviceCluster }),
  );
  if (!list.containerInstanceArns?.length) return false;

  const details = await ecs.send(
    new DescribeContainerInstancesCommand({
      cluster: config.serviceCluster,
      containerInstances: list.containerInstanceArns,
    }),
  );

  return (details.containerInstances ?? []).some(
    (i) => i.status === "ACTIVE" && i.agentConnected === true,
  );
}

async function getAsg() {
  const response = await autoscaling.send(
    new DescribeAutoScalingGroupsCommand({
      AutoScalingGroupNames: [config.serviceAsgName],
    }),
  );
  const asg = response.AutoScalingGroups?.[0];
  if (!asg) throw new Error("Auto Scaling Group not found");
  return asg;
}

async function waitForContainerInstance(): Promise<void> {
  const deadline = Date.now() + config.capacityWaitTimeout;

  while (Date.now() < deadline) {
    if (await hasReadyContainerInstance()) {
      return;
    }
    await new Promise((r) => setTimeout(r, config.pollInterval));
  }

  throw new Error("Timeout waiting for EC2 capacity");
}
