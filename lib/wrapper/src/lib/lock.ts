import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient());
const TABLE_NAME = process.env.LAUNCH_LOCKS_TABLE_NAME!;
const LOCK_TTL_SECONDS = 15 * 60; // 15 minutes

export interface LockResult {
  acquired: boolean;
  reason?: string;
}

export async function acquireLock(serviceName: string): Promise<LockResult> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = now + LOCK_TTL_SECONDS;

  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          serviceName,
          lockedAt: now,
          ttl,
        },
        ConditionExpression: "attribute_not_exists(serviceName) OR #ttl < :now",
        ExpressionAttributeNames: {
          "#ttl": "ttl",
        },
        ExpressionAttributeValues: {
          ":now": now,
        },
      }),
    );

    return { acquired: true };
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") {
      return {
        acquired: false,
        reason: "Service launch already in progress",
      };
    }
    throw error;
  }
}

export async function releaseLock(serviceName: string): Promise<void> {
  try {
    await dynamoClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { serviceName },
      }),
    );
  } catch (error) {
    console.warn(`[${serviceName}] Failed to release lock:`, error);
  }
}

export async function isLocked(serviceName: string): Promise<boolean> {
  try {
    const result = await dynamoClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { serviceName },
      }),
    );

    if (!result.Item) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    if (result.Item.ttl && result.Item.ttl < now) {
      await releaseLock(serviceName);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`[${serviceName}] Error checking lock:`, error);
    return false;
  }
}
