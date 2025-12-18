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
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Task } from "@aws-sdk/client-ecs";
import type { EventBridgeEvent } from "aws-lambda";

const ecsClient = new ECSClient();
const autoScalingClient = new AutoScalingClient();
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SERVICE_CLUSTER = process.env.SERVICE_CLUSTER!;
const SERVICE_ASG_NAME = process.env.SERVICE_ASG_NAME!;
const LOCK_TABLE_NAME = process.env.LAUNCH_LOCKS_TABLE_NAME!;
const AUTOSCALER_LOCK_KEY = "autoscaler";
const LOCK_TTL_SECONDS = 5 * 60; // 5 minutes

const MAX_TASKS_PER_INSTANCE = parseInt(
  process.env.MAX_TASKS_PER_INSTANCE || "3",
  10,
);

async function acquireAutoscalerLock(): Promise<boolean> {
  if (!LOCK_TABLE_NAME) {
    console.warn("Lock table not configured, proceeding without lock");
    return true;
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = now + LOCK_TTL_SECONDS;

  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: LOCK_TABLE_NAME,
        Item: {
          serviceName: AUTOSCALER_LOCK_KEY,
          lockedAt: now,
          ttl,
        },
        ConditionExpression: "attribute_not_exists(serviceName) OR ttl < :now",
        ExpressionAttributeValues: {
          ":now": now,
        },
      }),
    );
    return true;
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") {
      console.log("Autoscaler lock already held, skipping this invocation");
      return false;
    }
    console.error("Error acquiring autoscaler lock:", error);
    // On error, proceed anyway to avoid blocking autoscaling
    return true;
  }
}

async function releaseAutoscalerLock(): Promise<void> {
  if (!LOCK_TABLE_NAME) return;

  try {
    await dynamoClient.send(
      new DeleteCommand({
        TableName: LOCK_TABLE_NAME,
        Key: { serviceName: AUTOSCALER_LOCK_KEY },
      }),
    );
  } catch (error) {
    console.warn("Failed to release autoscaler lock:", error);
  }
}

export const handler = async (
  event:
    | EventBridgeEvent<"ECS Task State Change", Task>
    | { source?: string; detail?: unknown }
    | null
    | undefined
    | Record<string, unknown>,
): Promise<void> => {
  // Acquire lock to prevent concurrent autoscaler executions
  const lockAcquired = await acquireAutoscalerLock();
  if (!lockAcquired) {
    return;
  }

  try {
    // Handle manual invocations, scheduled events, or events without detail
    if (!event || !("detail" in event) || !event.detail) {
      console.log("Manual or scheduled autoscaler check");
      await evaluateAndScale();
      return;
    }

    // Handle task state change events
    const { detail } = event as EventBridgeEvent<"ECS Task State Change", Task>;
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

    console.log("Task state change triggered autoscaler", {
      lastStatus,
      clusterName,
    });

    await evaluateAndScale();
  } finally {
    await releaseAutoscalerLock();
  }
};

async function evaluateAndScale(): Promise<void> {
  // Get current state atomically (as much as possible)
  const [tasks, instances] = await Promise.all([
    listActiveTasks(),
    listContainerInstances(),
  ]);

  console.log("Autoscaler evaluation", {
    taskCount: tasks.length,
    instanceCount: instances.length,
  });

  if (instances.length === 0) {
    const requiredInstances = Math.ceil(tasks.length / MAX_TASKS_PER_INSTANCE);
    console.log("No instances, calculating required", { requiredInstances });
    if (requiredInstances > 0) {
      await setAutoScalingGroupCapacity(requiredInstances);
    }
    return;
  }

  // Calculate task counts per instance
  const instanceTaskCounts = await getInstanceTaskCounts(instances, tasks);

  // Update instance protection BEFORE making scaling decisions
  // This ensures instances with tasks are protected from scale-in
  // Note: There's still a small race window where tasks could be placed
  // between protection update and scaling, but the lock minimizes this
  await updateInstanceProtection(instances, instanceTaskCounts);

  // Re-fetch instances after protection update to get latest state
  // (though instances list shouldn't change immediately)
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

  console.log("Scale decision", {
    totalTasks,
    totalInstances,
    emptyInstances,
    desiredCapacity,
  });

  if (desiredCapacity !== totalInstances) {
    console.log("Scaling ASG", { from: totalInstances, to: desiredCapacity });
    await setAutoScalingGroupCapacity(desiredCapacity);
  } else {
    console.log("No scaling needed - capacity matches desired");
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
