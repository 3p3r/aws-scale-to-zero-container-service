import {
  ServiceDiscoveryClient,
  CreateServiceCommand,
  ListServicesCommand,
  RegisterInstanceCommand,
  DeregisterInstanceCommand,
  GetInstanceCommand,
} from "@aws-sdk/client-servicediscovery";
import type { Task, LaunchType } from "@aws-sdk/client-ecs";
import type { EventBridgeEvent } from "aws-lambda";

const serviceDiscoveryClient = new ServiceDiscoveryClient();

const PROXY_PORT = parseInt(process.env.PROXY_PORT || "9060", 10);
const SERVICE_PORT = parseInt(process.env.SERVICE_PORT || "9050", 10);

export const handler = async (
  event: EventBridgeEvent<"ECS Task State Change", Task>,
): Promise<void> => {
  const { detail } = event;
  const { taskArn, lastStatus, launchType, clusterArn } = detail;
  const namespaceId = process.env.NAMESPACE_ID;
  const allowedClusterArns = process.env.ALLOWED_CLUSTER_ARNS?.split(",") || [];

  if (!namespaceId || !taskArn || !lastStatus || !launchType || !clusterArn) {
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

  const serviceDiscoveryServiceName =
    launchType === "FARGATE"
      ? `${serviceName}.proxy`
      : `${serviceName}.service`;

  if (lastStatus === "RUNNING") {
    await handleTaskRunning(
      namespaceId,
      serviceDiscoveryServiceName,
      taskArn,
      detail,
      launchType,
    );
  } else if (lastStatus === "STOPPED") {
    await handleTaskStopped(namespaceId, serviceDiscoveryServiceName, taskArn);
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

async function getOrCreateService(
  namespaceId: string,
  serviceName: string,
): Promise<string> {
  const listServicesResponse = await serviceDiscoveryClient.send(
    new ListServicesCommand({
      Filters: [{ Name: "NAMESPACE_ID", Values: [namespaceId] }],
    }),
  );

  const existingService = listServicesResponse.Services?.find(
    (svc) => svc.Name === serviceName,
  );
  if (existingService?.Id) {
    return existingService.Id;
  }

  const createServiceResponse = await serviceDiscoveryClient.send(
    new CreateServiceCommand({
      Name: serviceName,
      NamespaceId: namespaceId,
      DnsConfig: {
        DnsRecords: [{ Type: "A", TTL: 60 }],
      },
    }),
  );

  if (!createServiceResponse.Service?.Id) {
    throw new Error(
      `Failed to create service discovery service: ${serviceName}`,
    );
  }

  return createServiceResponse.Service.Id;
}

function extractNetworkingInfo(
  detail: Task,
  launchType: LaunchType,
): { ipAddress: string; port: number } | null {
  let ipAddress: string | null = null;

  for (const attachment of detail.attachments || []) {
    if (attachment.type === "eni") {
      const ipDetail = attachment.details?.find(
        (d) => d.name === "privateIPv4Address",
      );
      if (ipDetail?.value) {
        ipAddress = ipDetail.value;
        break;
      }
    }
  }

  if (!ipAddress) {
    for (const container of detail.containers || []) {
      if (container.networkInterfaces?.[0]?.privateIpv4Address) {
        ipAddress = container.networkInterfaces[0].privateIpv4Address;
        break;
      }
    }
  }

  if (!ipAddress) {
    return null;
  }

  const port = launchType === "FARGATE" ? PROXY_PORT : SERVICE_PORT;
  return { ipAddress, port };
}

async function handleTaskRunning(
  namespaceId: string,
  serviceDiscoveryServiceName: string,
  taskArn: string,
  detail: Task,
  launchType: LaunchType,
): Promise<void> {
  const networkingInfo = extractNetworkingInfo(detail, launchType);
  if (!networkingInfo) {
    throw new Error(`Could not extract networking info for task ${taskArn}`);
  }

  const { ipAddress, port } = networkingInfo;
  const serviceId = await getOrCreateService(
    namespaceId,
    serviceDiscoveryServiceName,
  );
  const taskId = taskArn.split("/").pop() || taskArn;

  try {
    await serviceDiscoveryClient.send(
      new RegisterInstanceCommand({
        ServiceId: serviceId,
        InstanceId: taskId,
        Attributes: {
          AWS_INSTANCE_IPV4: ipAddress,
          AWS_INSTANCE_PORT: port.toString(),
        },
      }),
    );
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      (error.name === "DuplicateRequest" ||
        error.name === "ResourceInUseException")
    ) {
      return;
    }
    throw error;
  }
}

async function handleTaskStopped(
  namespaceId: string,
  serviceDiscoveryServiceName: string,
  taskArn: string,
): Promise<void> {
  const listServicesResponse = await serviceDiscoveryClient.send(
    new ListServicesCommand({
      Filters: [{ Name: "NAMESPACE_ID", Values: [namespaceId] }],
    }),
  );

  const service = listServicesResponse.Services?.find(
    (svc) => svc.Name === serviceDiscoveryServiceName,
  );

  if (!service?.Id) {
    return;
  }

  const taskId = taskArn.split("/").pop() || taskArn;

  try {
    await serviceDiscoveryClient.send(
      new GetInstanceCommand({
        ServiceId: service.Id,
        InstanceId: taskId,
      }),
    );
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "InstanceNotFound"
    ) {
      return;
    }
    throw error;
  }

  try {
    await serviceDiscoveryClient.send(
      new DeregisterInstanceCommand({
        ServiceId: service.Id,
        InstanceId: taskId,
      }),
    );
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "InstanceNotFound"
    ) {
      return;
    }
    throw error;
  }
}
