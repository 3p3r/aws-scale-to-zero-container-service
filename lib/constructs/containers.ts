import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { Networking } from "./networking";

export interface ContainersProps {
  networking: Networking;
}

export class Containers extends Construct {
  public readonly proxyCluster: ecs.Cluster;
  public readonly serviceCluster: ecs.Cluster;
  public readonly proxyTaskDefinition: ecs.FargateTaskDefinition;
  public readonly serviceTaskDefinition: ecs.Ec2TaskDefinition;

  constructor(scope: Construct, id: string, props: ContainersProps) {
    super(scope, id);

    this.proxyCluster = new ecs.Cluster(this, "FargateCluster", {
      vpc: props.networking.vpc,
      clusterName: "FargateCluster",
    });

    this.serviceCluster = new ecs.Cluster(this, "Ec2Cluster", {
      vpc: props.networking.vpc,
      clusterName: "Ec2Cluster",
      capacity: {
        instanceType: new ec2.InstanceType("t3.micro"),
      },
    });

    this.proxyTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "ProxyTaskDef",
      {
        memoryLimitMiB: 512,
        cpu: 256,
      },
    );

    this.proxyTaskDefinition.addContainer("ProxyContainer", {
      image: ecs.ContainerImage.fromAsset("lib/proxy"),
      portMappings: [{ containerPort: 9060 }],
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

    this.serviceTaskDefinition.addContainer("ServiceContainer", {
      image: ecs.ContainerImage.fromAsset("lib/service"),
      portMappings: [{ containerPort: 9050 }],
      memoryLimitMiB: 512,
      environment: {
        NAMESPACE: props.networking.namespace.namespaceName,
      },
    });
  }
}
