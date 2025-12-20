import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
} from "@aws-sdk/client-route-53";
import type { Task } from "@aws-sdk/client-ecs";
import type { EventBridgeEvent } from "aws-lambda";

const route53Client = new Route53Client();

export const handler = async (
  event: EventBridgeEvent<"ECS Task State Change", Task>,
): Promise<void> => {
  const { detail } = event;
  const { taskArn, lastStatus, launchType, clusterArn } = detail;
  const hostedZoneId = process.env.HOSTED_ZONE_ID;
  const domain = process.env.DOMAIN;
  const allowedClusterArns = process.env.ALLOWED_CLUSTER_ARNS?.split(",") || [];

  if (!hostedZoneId || !domain || !taskArn || !lastStatus || !clusterArn) {
    return;
  }

  if (
    allowedClusterArns.length > 0 &&
    !allowedClusterArns.includes(clusterArn)
  ) {
    return;
  }

  const serviceName = extractServiceName(detail);
  if (!serviceName) {
    return;
  }

  if (launchType === "FARGATE" && lastStatus === "STOPPED") {
    await deleteRoute53Record(hostedZoneId, serviceName, domain);
  }
};

function extractServiceName(detail: Task): string | null {
  for (const containerOverride of detail.overrides?.containerOverrides || []) {
    const serviceNameEnv = containerOverride.environment?.find(
      (env) => env.name === "SERVICE_NAME",
    );
    if (serviceNameEnv?.value) {
      return serviceNameEnv.value;
    }
  }
  return null;
}

async function deleteRoute53Record(
  hostedZoneId: string,
  serviceName: string,
  domain: string,
): Promise<void> {
  const recordName = `${serviceName}.${domain}`;
  const normalizedRecordName = `${recordName}.`;

  try {
    const listResponse = await route53Client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        StartRecordName: recordName,
        StartRecordType: "A",
        MaxItems: 100,
      }),
    );

    const matchingRecords =
      listResponse.ResourceRecordSets?.filter(
        (r) => r.Name === normalizedRecordName && r.Type === "A",
      ) || [];

    if (matchingRecords.length === 0) {
      console.log(`No Route53 record found to delete: ${recordName}`);
      return;
    }

    if (matchingRecords.length > 1) {
      console.warn(
        `Multiple Route53 records found for ${recordName}, deleting all ${matchingRecords.length} records`,
      );
    }

    for (const record of matchingRecords) {
      if (record.ResourceRecords && record.ResourceRecords.length > 0) {
        try {
          await route53Client.send(
            new ChangeResourceRecordSetsCommand({
              HostedZoneId: hostedZoneId,
              ChangeBatch: {
                Changes: [
                  {
                    Action: "DELETE",
                    ResourceRecordSet: {
                      Name: record.Name,
                      Type: record.Type,
                      TTL: record.TTL,
                      ResourceRecords: record.ResourceRecords,
                    },
                  },
                ],
              },
            }),
          );
          console.log(
            `Deleted Route53 record: ${record.Name} (${record.ResourceRecords.map((r) => r.Value).join(", ")})`,
          );
        } catch (deleteError: any) {
          console.warn(
            `Failed to delete Route53 record ${record.Name}: ${deleteError.message}`,
          );
        }
      }
    }
  } catch (error: any) {
    console.log(
      `Could not delete Route53 record ${recordName}: ${error.message}`,
    );
  }
}
