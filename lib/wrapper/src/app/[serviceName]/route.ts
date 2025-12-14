import { NextRequest, NextResponse } from "next/server";
import assert from "node:assert";
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

const ecsClient = new ECSClient();
const autoScalingClient = new AutoScalingClient();

const _PROXY_CLUSTER = process.env.PROXY_CLUSTER;
const _SERVICE_CLUSTER = process.env.SERVICE_CLUSTER;
const _PROXY_TASK_DEFINITION = process.env.PROXY_TASK_DEFINITION;
const _SERVICE_TASK_DEFINITION = process.env.SERVICE_TASK_DEFINITION;
const PROXY_SUBNET_IDS = process.env.PROXY_SUBNET_IDS?.split(",") || [];
const SERVICE_SUBNET_IDS = process.env.SERVICE_SUBNET_IDS?.split(",") || [];
const _SECURITY_GROUP_ID = process.env.SECURITY_GROUP_ID;

assert(_PROXY_CLUSTER, "Missing required environment variable: PROXY_CLUSTER");
assert(
  _SERVICE_CLUSTER,
  "Missing required environment variable: SERVICE_CLUSTER",
);
assert(
  _PROXY_TASK_DEFINITION,
  "Missing required environment variable: PROXY_TASK_DEFINITION",
);
assert(
  _SERVICE_TASK_DEFINITION,
  "Missing required environment variable: SERVICE_TASK_DEFINITION",
);
assert(
  _SECURITY_GROUP_ID,
  "Missing required environment variable: SECURITY_GROUP_ID",
);

const PROXY_CLUSTER: string = _PROXY_CLUSTER;
const SERVICE_CLUSTER: string = _SERVICE_CLUSTER;
const PROXY_TASK_DEFINITION: string = _PROXY_TASK_DEFINITION;
const SERVICE_TASK_DEFINITION: string = _SERVICE_TASK_DEFINITION;
const SECURITY_GROUP_ID: string = _SECURITY_GROUP_ID;

if (PROXY_SUBNET_IDS.length === 0 || SERVICE_SUBNET_IDS.length === 0) {
  throw new Error(
    "Missing required environment variables: PROXY_SUBNET_IDS or SERVICE_SUBNET_IDS",
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ serviceName: string }> },
) {
  try {
    const { serviceName } = await params;

    const existingTasks = await checkExistingTasks(serviceName);
    if (existingTasks.exists) {
      return NextResponse.json({
        message: `Service ${serviceName} already running`,
        proxyTask: existingTasks.proxyTaskArn,
        serviceTask: existingTasks.serviceTaskArn,
      });
    }

    await ensureEc2Capacity();

    const [proxyTask, serviceTask] = await Promise.all([
      launchProxyTask(serviceName),
      launchServiceTask(serviceName),
    ]);

    return NextResponse.json({
      message: `Service ${serviceName} launched`,
      proxyTask: proxyTask.taskArn,
      serviceTask: serviceTask.taskArn,
    });
  } catch (error) {
    console.error("Error in route handler:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

async function checkExistingTasks(serviceName: string): Promise<{
  exists: boolean;
  proxyTaskArn?: string;
  serviceTaskArn?: string;
}> {
  const [proxyTasks, serviceTasks] = await Promise.all([
    ecsClient.send(
      new ListTasksCommand({
        cluster: PROXY_CLUSTER,
        desiredStatus: "RUNNING",
      }),
    ),
    ecsClient.send(
      new ListTasksCommand({
        cluster: SERVICE_CLUSTER,
        desiredStatus: "RUNNING",
      }),
    ),
  ]);

  if (!proxyTasks.taskArns?.length || !serviceTasks.taskArns?.length) {
    return { exists: false };
  }

  const allTasks = [
    ...(proxyTasks.taskArns.map((arn) => ({ arn, cluster: PROXY_CLUSTER })) ||
      []),
    ...(serviceTasks.taskArns.map((arn) => ({
      arn,
      cluster: SERVICE_CLUSTER,
    })) || []),
  ];

  const taskDetails = await Promise.all(
    allTasks.map(({ arn, cluster }) =>
      ecsClient.send(
        new DescribeTasksCommand({
          cluster,
          tasks: [arn],
        }),
      ),
    ),
  );

  let proxyTaskArn: string | undefined;
  let serviceTaskArn: string | undefined;

  for (const response of taskDetails) {
    for (const task of response.tasks || []) {
      let serviceNameValue: string | undefined;

      const overrideEnv = task.overrides?.containerOverrides
        ?.flatMap((override) => override.environment || [])
        .find((env) => env.name === "SERVICE_NAME");
      if (overrideEnv?.value) {
        serviceNameValue = overrideEnv.value;
      }

      if (serviceNameValue === serviceName) {
        if (task.launchType === "FARGATE") {
          proxyTaskArn = task.taskArn;
        } else if (task.launchType === "EC2") {
          serviceTaskArn = task.taskArn;
        }
      }
    }
  }

  return {
    exists: !!proxyTaskArn && !!serviceTaskArn,
    proxyTaskArn,
    serviceTaskArn,
  };
}

async function ensureEc2Capacity(): Promise<void> {
  const asgName = await getAutoScalingGroupName();
  if (!asgName) {
    throw new Error("Could not find Auto Scaling Group for EC2 cluster");
  }

  const asgResponse = await autoScalingClient.send(
    new DescribeAutoScalingGroupsCommand({
      AutoScalingGroupNames: [asgName],
    }),
  );

  const asg = asgResponse.AutoScalingGroups?.[0];
  if (!asg) {
    throw new Error("Auto Scaling Group not found");
  }

  const currentCapacity = asg.Instances?.length || 0;
  if (currentCapacity === 0) {
    await autoScalingClient.send(
      new SetDesiredCapacityCommand({
        AutoScalingGroupName: asgName,
        DesiredCapacity: 1,
        HonorCooldown: false,
      }),
    );

    await waitForCapacity(asgName);
  }
}

async function waitForCapacity(
  asgName: string,
  maxWaitSeconds = 300,
): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 5000;

  while (Date.now() - startTime < maxWaitSeconds * 1000) {
    const asgResponse = await autoScalingClient.send(
      new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [asgName],
      }),
    );

    const asg = asgResponse.AutoScalingGroups?.[0];
    const instances = asg?.Instances || [];
    const readyInstances = instances.filter(
      (inst) => inst.LifecycleState === "InService",
    );

    if (readyInstances.length > 0) {
      const containerInstancesResponse = await ecsClient.send(
        new ListContainerInstancesCommand({
          cluster: SERVICE_CLUSTER,
        }),
      );

      if (containerInstancesResponse.containerInstanceArns?.length) {
        const instanceDetails = await ecsClient.send(
          new DescribeContainerInstancesCommand({
            cluster: SERVICE_CLUSTER,
            containerInstances:
              containerInstancesResponse.containerInstanceArns.slice(0, 1),
          }),
        );

        const instance = instanceDetails.containerInstances?.[0];
        if (
          instance &&
          instance.status === "ACTIVE" &&
          instance.agentConnected === true
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error("Timeout waiting for EC2 capacity");
}

async function getAutoScalingGroupName(): Promise<string | null> {
  const response = await autoScalingClient.send(
    new DescribeAutoScalingGroupsCommand({}),
  );

  for (const asg of response.AutoScalingGroups || []) {
    const tags = asg.Tags || [];
    const clusterTag = tags.find(
      (tag) => tag.Key === "ECSCluster" && tag.Value === SERVICE_CLUSTER,
    );
    if (clusterTag) {
      return asg.AutoScalingGroupName || null;
    }
  }

  return null;
}

async function launchProxyTask(serviceName: string) {
  const response = await ecsClient.send(
    new RunTaskCommand({
      cluster: PROXY_CLUSTER,
      taskDefinition: PROXY_TASK_DEFINITION,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: PROXY_SUBNET_IDS,
          securityGroups: [SECURITY_GROUP_ID],
          assignPublicIp: "ENABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: "ProxyContainer",
            environment: [
              {
                name: "SERVICE_NAME",
                value: serviceName,
              },
            ],
          },
        ],
      },
    }),
  );

  if (!response.tasks?.[0]) {
    throw new Error("Failed to launch proxy task");
  }

  return response.tasks[0];
}

async function launchServiceTask(serviceName: string) {
  const response = await ecsClient.send(
    new RunTaskCommand({
      cluster: SERVICE_CLUSTER,
      taskDefinition: SERVICE_TASK_DEFINITION,
      launchType: "EC2",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SERVICE_SUBNET_IDS,
          securityGroups: [SECURITY_GROUP_ID],
          assignPublicIp: "DISABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: "ServiceContainer",
            environment: [
              {
                name: "SERVICE_NAME",
                value: serviceName,
              },
            ],
          },
        ],
      },
    }),
  );

  if (!response.tasks?.[0]) {
    throw new Error("Failed to launch service task");
  }

  return response.tasks[0];
}
