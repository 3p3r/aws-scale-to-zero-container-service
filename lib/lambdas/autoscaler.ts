import {
  ECSClient,
  ListTasksCommand,
  ListContainerInstancesCommand,
  DescribeContainerInstancesCommand,
  DescribeTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  SetDesiredCapacityCommand,
  SetInstanceProtectionCommand,
} from "@aws-sdk/client-auto-scaling";
import type { Task } from "@aws-sdk/client-ecs";
import type { EventBridgeEvent } from "aws-lambda";

const ecsClient = new ECSClient();
const autoScalingClient = new AutoScalingClient();

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
  if (!clusterName) {
    return;
  }

  await evaluateAndScale(clusterName);
};

async function evaluateAndScale(clusterName: string): Promise<void> {
  const tasks = await listRunningTasks(clusterName);
  const instances = await listContainerInstances(clusterName);

  const asgName = await getAutoScalingGroupName(clusterName, instances);
  if (!asgName) {
    return;
  }

  if (instances.length === 0) {
    const requiredInstances = Math.ceil(tasks.length / MAX_TASKS_PER_INSTANCE);
    if (requiredInstances > 0) {
      await setAutoScalingGroupCapacity(asgName, requiredInstances);
    }
    return;
  }

  const instanceTaskCounts = await getInstanceTaskCounts(
    clusterName,
    instances,
    tasks,
  );

  await updateInstanceProtection(
    clusterName,
    instances,
    instanceTaskCounts,
    asgName,
  );

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
    await setAutoScalingGroupCapacity(asgName, desiredCapacity);
  }
}

async function listRunningTasks(clusterName: string): Promise<string[]> {
  const tasks: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ecsClient.send(
      new ListTasksCommand({
        cluster: clusterName,
        desiredStatus: "RUNNING",
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

async function listContainerInstances(clusterName: string): Promise<string[]> {
  const instances: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ecsClient.send(
      new ListContainerInstancesCommand({
        cluster: clusterName,
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
  clusterName: string,
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
        cluster: clusterName,
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
  clusterName: string,
  instanceArns: string[],
  instanceTaskCounts: Map<string, number>,
  asgName: string,
): Promise<void> {
  const instanceDetails = await ecsClient.send(
    new DescribeContainerInstancesCommand({
      cluster: clusterName,
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
        AutoScalingGroupName: asgName,
        InstanceIds: instancesToProtect,
        ProtectedFromScaleIn: true,
      }),
    );
  }

  if (instancesToUnprotect.length > 0) {
    await autoScalingClient.send(
      new SetInstanceProtectionCommand({
        AutoScalingGroupName: asgName,
        InstanceIds: instancesToUnprotect,
        ProtectedFromScaleIn: false,
      }),
    );
  }
}

async function getAutoScalingGroupName(
  clusterName: string,
  instanceArns: string[],
): Promise<string | null> {
  if (instanceArns.length === 0) {
    const response = await autoScalingClient.send(
      new DescribeAutoScalingGroupsCommand({}),
    );

    for (const asg of response.AutoScalingGroups || []) {
      const tags = asg.Tags || [];
      const clusterTag = tags.find(
        (tag) => tag.Key === "ECSCluster" && tag.Value === clusterName,
      );
      if (clusterTag) {
        return asg.AutoScalingGroupName || null;
      }
    }
    return null;
  }

  const instanceDetails = await ecsClient.send(
    new DescribeContainerInstancesCommand({
      cluster: clusterName,
      containerInstances: [instanceArns[0]],
    }),
  );

  const ec2InstanceId = instanceDetails.containerInstances?.[0]?.ec2InstanceId;
  if (!ec2InstanceId) {
    return null;
  }

  const response = await autoScalingClient.send(
    new DescribeAutoScalingGroupsCommand({}),
  );

  for (const asg of response.AutoScalingGroups || []) {
    if (asg.Instances?.some((inst) => inst.InstanceId === ec2InstanceId)) {
      return asg.AutoScalingGroupName || null;
    }
  }

  return null;
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
  asgName: string,
  desiredCapacity: number,
): Promise<void> {
  await autoScalingClient.send(
    new SetDesiredCapacityCommand({
      AutoScalingGroupName: asgName,
      DesiredCapacity: desiredCapacity,
      HonorCooldown: false,
    }),
  );
}
