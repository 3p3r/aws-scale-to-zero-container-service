import {
  ECSClient,
  ListTasksCommand,
  ListContainerInstancesCommand,
  DescribeContainerInstancesCommand,
  DescribeTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  AutoScalingClient,
  SetDesiredCapacityCommand,
  SetInstanceProtectionCommand,
} from "@aws-sdk/client-auto-scaling";
import type { Task } from "@aws-sdk/client-ecs";
import type { EventBridgeEvent } from "aws-lambda";

const ecsClient = new ECSClient();
const autoScalingClient = new AutoScalingClient();

const SERVICE_CLUSTER = process.env.SERVICE_CLUSTER!;
const SERVICE_ASG_NAME = process.env.SERVICE_ASG_NAME!;

const MAX_TASKS_PER_INSTANCE = 3;

export const handler = async (
  event: EventBridgeEvent<"ECS Task State Change", Task>,
): Promise<void> => {
  const { detail } = event;
  const { clusterArn, launchType, lastStatus } = detail;

  if (!clusterArn || !launchType || !lastStatus) {
    return;
  }

  if (launchType !== "EC2") {
    return;
  }

  const clusterName = clusterArn.split("/").pop();
  if (clusterName !== SERVICE_CLUSTER) {
    return;
  }

  await evaluateAndScale();
};

async function evaluateAndScale(): Promise<void> {
  const tasks = await listActiveTasks();
  const instances = await listContainerInstances();

  if (instances.length === 0) {
    const requiredInstances = Math.ceil(tasks.length / MAX_TASKS_PER_INSTANCE);
    if (requiredInstances > 0) {
      await setAutoScalingGroupCapacity(requiredInstances);
    }
    return;
  }

  const instanceTaskCounts = await getInstanceTaskCounts(instances, tasks);

  await updateInstanceProtection(instances, instanceTaskCounts);

  const totalTasks = tasks.length;
  const totalInstances = instances.length;
  const emptyInstances = instances.filter(
    (instanceId) => (instanceTaskCounts.get(instanceId) || 0) === 0,
  ).length;

  const desiredCapacity = calculateDesiredCapacity(
    totalTasks,
    totalInstances,
    emptyInstances,
  );

  if (desiredCapacity !== totalInstances) {
    await setAutoScalingGroupCapacity(desiredCapacity);
  }
}

async function listActiveTasks(): Promise<string[]> {
  // List both RUNNING and PENDING to avoid scaling down while tasks are starting
  const [running, pending] = await Promise.all([
    listTasksByStatus("RUNNING"),
    listTasksByStatus("PENDING"),
  ]);
  return [...running, ...pending];
}

async function listTasksByStatus(
  desiredStatus: "RUNNING" | "PENDING",
): Promise<string[]> {
  const tasks: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ecsClient.send(
      new ListTasksCommand({
        cluster: SERVICE_CLUSTER,
        desiredStatus,
        nextToken,
      }),
    );

    if (response.taskArns) {
      tasks.push(...response.taskArns);
    }

    nextToken = response.nextToken;
  } while (nextToken);

  return tasks;
}

async function listContainerInstances(): Promise<string[]> {
  const instances: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ecsClient.send(
      new ListContainerInstancesCommand({
        cluster: SERVICE_CLUSTER,
        nextToken,
      }),
    );

    if (response.containerInstanceArns) {
      instances.push(...response.containerInstanceArns);
    }

    nextToken = response.nextToken;
  } while (nextToken);

  return instances;
}

async function getInstanceTaskCounts(
  instanceArns: string[],
  taskArns: string[],
): Promise<Map<string, number>> {
  const instanceTaskCounts = new Map<string, number>();

  for (const instanceArn of instanceArns) {
    instanceTaskCounts.set(instanceArn, 0);
  }

  if (taskArns.length === 0) {
    return instanceTaskCounts;
  }

  const tasksPerBatch = 100;
  for (let i = 0; i < taskArns.length; i += tasksPerBatch) {
    const batch = taskArns.slice(i, i + tasksPerBatch);
    const response = await ecsClient.send(
      new DescribeTasksCommand({
        cluster: SERVICE_CLUSTER,
        tasks: batch,
      }),
    );

    for (const task of response.tasks || []) {
      if (task.containerInstanceArn) {
        const currentCount =
          instanceTaskCounts.get(task.containerInstanceArn) || 0;
        instanceTaskCounts.set(task.containerInstanceArn, currentCount + 1);
      }
    }
  }

  return instanceTaskCounts;
}

async function updateInstanceProtection(
  instanceArns: string[],
  instanceTaskCounts: Map<string, number>,
): Promise<void> {
  const instanceDetails = await ecsClient.send(
    new DescribeContainerInstancesCommand({
      cluster: SERVICE_CLUSTER,
      containerInstances: instanceArns,
    }),
  );

  const instancesToProtect: string[] = [];
  const instancesToUnprotect: string[] = [];

  for (const instance of instanceDetails.containerInstances || []) {
    if (!instance.ec2InstanceId) {
      continue;
    }

    const instanceArn = instance.containerInstanceArn;
    if (!instanceArn) {
      continue;
    }

    const taskCount = instanceTaskCounts.get(instanceArn) || 0;
    if (taskCount > 0) {
      instancesToProtect.push(instance.ec2InstanceId);
    } else {
      instancesToUnprotect.push(instance.ec2InstanceId);
    }
  }

  if (instancesToProtect.length > 0) {
    await autoScalingClient.send(
      new SetInstanceProtectionCommand({
        AutoScalingGroupName: SERVICE_ASG_NAME,
        InstanceIds: instancesToProtect,
        ProtectedFromScaleIn: true,
      }),
    );
  }

  if (instancesToUnprotect.length > 0) {
    await autoScalingClient.send(
      new SetInstanceProtectionCommand({
        AutoScalingGroupName: SERVICE_ASG_NAME,
        InstanceIds: instancesToUnprotect,
        ProtectedFromScaleIn: false,
      }),
    );
  }
}

function calculateDesiredCapacity(
  totalTasks: number,
  currentInstances: number,
  emptyInstances: number,
): number {
  if (totalTasks === 0) {
    return 0;
  }

  const requiredInstances = Math.ceil(totalTasks / MAX_TASKS_PER_INSTANCE);

  if (requiredInstances > currentInstances) {
    return requiredInstances;
  }

  if (
    emptyInstances > 0 &&
    totalTasks <= (currentInstances - emptyInstances) * MAX_TASKS_PER_INSTANCE
  ) {
    return Math.max(requiredInstances, currentInstances - emptyInstances);
  }

  return currentInstances;
}

async function setAutoScalingGroupCapacity(
  desiredCapacity: number,
): Promise<void> {
  await autoScalingClient.send(
    new SetDesiredCapacityCommand({
      AutoScalingGroupName: SERVICE_ASG_NAME,
      DesiredCapacity: desiredCapacity,
      HonorCooldown: false,
    }),
  );
}
