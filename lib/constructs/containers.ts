import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
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
    });

    this.serviceCluster = new ecs.Cluster(this, "Ec2Cluster", {
      vpc: props.networking.vpc,
    });

    this.serviceAutoScalingGroup = this.serviceCluster.addCapacity(
      "Ec2Capacity",
      {
        instanceType: new ec2.InstanceType("t3.micro"),
        minCapacity: 0,
        maxCapacity: 10,
        desiredCapacity: 0,
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

    // Grant Route53 permissions to proxy task for DNS registration
    this.proxyTaskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "route53:ChangeResourceRecordSets",
          "route53:ListResourceRecordSets",
        ],
        resources: [props.networking.hostedZone.hostedZoneArn],
      }),
    );

    this.proxyTaskDefinition.addContainer(Containers.PROXY_CONTAINER_NAME, {
      image: ecs.ContainerImage.fromAsset("lib/proxy"),
      portMappings: [{ containerPort: Containers.PROXY_PORT }],
      environment: {
        HOSTED_ZONE_ID: props.networking.hostedZone.hostedZoneId,
        DOMAIN: props.networking.hostedZone.zoneName,
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          `curl -f http://localhost:${Containers.PROXY_PORT}/health || exit 1`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
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
      healthCheck: {
        command: [
          "CMD-SHELL",
          `curl -f http://localhost:${Containers.SERVICE_PORT}/ || exit 1`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });
  }
}
