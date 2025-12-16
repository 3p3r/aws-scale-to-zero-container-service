import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import { Networking } from "./networking";

export interface ContainersProps {
  networking: Networking;
}

export class Containers extends Construct {
  public readonly proxyCluster: ecs.Cluster;
  public readonly serviceCluster: ecs.Cluster;
  public readonly proxyTaskDefinition: ecs.FargateTaskDefinition;
  public readonly serviceTaskDefinition: ecs.Ec2TaskDefinition;
  public readonly serviceAutoScalingGroup: autoscaling.AutoScalingGroup;

  public static readonly PROXY_CONTAINER_NAME = "ProxyContainer";
  public static readonly SERVICE_CONTAINER_NAME = "ServiceContainer";
  public static readonly PROXY_PORT = 9060;
  public static readonly SERVICE_PORT = 9050;

  constructor(scope: Construct, id: string, props: ContainersProps) {
    super(scope, id);

    this.proxyCluster = new ecs.Cluster(this, "FargateCluster", {
      vpc: props.networking.vpc,
      clusterName: "FargateCluster",
    });

    this.serviceCluster = new ecs.Cluster(this, "Ec2Cluster", {
      vpc: props.networking.vpc,
      clusterName: "Ec2Cluster",
    });

    this.serviceAutoScalingGroup = this.serviceCluster.addCapacity(
      "Ec2Capacity",
      {
        instanceType: new ec2.InstanceType("t3.micro"),
      },
    );

    this.proxyTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "ProxyTaskDef",
      {
        memoryLimitMiB: 512,
        cpu: 256,
      },
    );

    this.proxyTaskDefinition.addContainer(Containers.PROXY_CONTAINER_NAME, {
      image: ecs.ContainerImage.fromAsset("lib/proxy"),
      portMappings: [{ containerPort: Containers.PROXY_PORT }],
      environment: {
        NAMESPACE: props.networking.namespace.namespaceName,
      },
    });

    this.serviceTaskDefinition = new ecs.Ec2TaskDefinition(
      this,
      "ServiceTaskDef",
      {
        networkMode: ecs.NetworkMode.AWS_VPC,
      },
    );

    this.serviceTaskDefinition.addContainer(Containers.SERVICE_CONTAINER_NAME, {
      image: ecs.ContainerImage.fromAsset("lib/service"),
      portMappings: [{ containerPort: Containers.SERVICE_PORT }],
      memoryLimitMiB: 512,
      environment: {
        NAMESPACE: props.networking.namespace.namespaceName,
      },
    });
  }
}
