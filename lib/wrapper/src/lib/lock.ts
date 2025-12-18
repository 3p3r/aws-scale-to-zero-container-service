import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.LAUNCH_LOCKS_TABLE_NAME!;
const LOCK_TTL_SECONDS = 15 * 60; // 15 minutes

export interface LockResult {
  acquired: boolean;
  reason?: string;
}

/**
 * Try to acquire a lock for a service name.
 * Returns { acquired: true } if lock was acquired, { acquired: false, reason } if already locked.
 */
export async function acquireLock(serviceName: string): Promise<LockResult> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = now + LOCK_TTL_SECONDS;

  try {
    // Try to create the lock item (will fail if it already exists and is not expired)
    // Condition: lock doesn't exist OR lock has expired (TTL < now)
    // Note: 'ttl' is a reserved keyword, so we must use ExpressionAttributeNames
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
          "#ttl": "ttl", // Map 'ttl' to avoid reserved keyword issues
        },
        ExpressionAttributeValues: {
          ":now": now,
        },
      }),
    );

    return { acquired: true };
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") {
      // Lock already exists and is not expired
      return {
        acquired: false,
        reason: "Service launch already in progress",
      };
    }
    // Other error - rethrow
    throw error;
  }
}

/**
 * Release a lock for a service name.
 */
export async function releaseLock(serviceName: string): Promise<void> {
  try {
    await dynamoClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { serviceName },
      }),
    );
  } catch (error) {
    // Log but don't throw - lock might have expired or been released already
    console.warn(`[${serviceName}] Failed to release lock:`, error);
  }
}

/**
 * Check if a lock exists for a service name.
 */
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

    // Check if lock has expired (TTL)
    const now = Math.floor(Date.now() / 1000);
    if (result.Item.ttl && result.Item.ttl < now) {
      // Lock expired, clean it up
      await releaseLock(serviceName);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`[${serviceName}] Error checking lock:`, error);
    // On error, assume not locked to avoid blocking
    return false;
  }
}
