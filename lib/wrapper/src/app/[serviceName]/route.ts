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
    const proxy = proxyTask ?? (await launchProxyTask(serviceName));

    let service = serviceTask;
    if (!service) {
      await ensureEc2Capacity();
      service = await launchServiceTask(serviceName);
    }

    return NextResponse.json({
      message: `Service ${serviceName} launched`,
      proxyTask: proxy,
      serviceTask: service,
    });
  } catch (error) {
    console.error("Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
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
  if (!taskArn) throw new Error("Failed to launch service task");
  return taskArn;
}

// --- EC2 Capacity ---

async function ensureEc2Capacity(): Promise<void> {
  if (await hasReadyContainerInstance()) return;

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
    if (await hasReadyContainerInstance()) return;
    await new Promise((r) => setTimeout(r, config.pollInterval));
  }

  throw new Error("Timeout waiting for EC2 capacity");
}
