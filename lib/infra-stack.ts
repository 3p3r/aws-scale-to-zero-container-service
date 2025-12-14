import * as cdk from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as dns from "aws-cdk-lib/aws-servicediscovery";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Nextjs } from "cdk-nextjs-standalone";

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    const proxyCluster = new ecs.Cluster(this, "FargateCluster", {
      vpc,
      clusterName: "FargateCluster",
    });

    const serviceCluster = new ecs.Cluster(this, "Ec2Cluster", {
      vpc,
      clusterName: "Ec2Cluster",
      capacity: {
        instanceType: new ec2.InstanceType("t3.micro"),
      },
    });

    const namespace = new dns.PrivateDnsNamespace(this, "Namespace", {
      name: "local",
      vpc,
    });

    const proxy = new ecs.FargateTaskDefinition(this, "ProxyTaskDef", {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    const proxyContainer = proxy.addContainer("ProxyContainer", {
      image: ecs.ContainerImage.fromAsset("lib/proxy"),
      portMappings: [{ containerPort: 9060 }],
      environment: {
        NAMESPACE: namespace.namespaceName,
      },
    });

    const service = new ecs.Ec2TaskDefinition(this, "ServiceTaskDef", {
      networkMode: ecs.NetworkMode.AWS_VPC,
    });

    const serviceContainer = service.addContainer("ServiceContainer", {
      image: ecs.ContainerImage.fromAsset("lib/service"),
      portMappings: [{ containerPort: 9050 }],
      environment: {
        NAMESPACE: namespace.namespaceName,
      },
    });

    const wrapper = new Nextjs(this, "Wrapper", {
      nextjsPath: "./wrapper",
      environment: {
        NAMESPACE: namespace.namespaceName,
        PROXY_CLUSTER: proxyCluster.clusterName,
        SERVICE_CLUSTER: serviceCluster.clusterName,
      },
    });

    const discovery = new NodejsFunction(this, "Discovery", {
      entry: "lib/lambdas/discovery.ts",
      runtime: lambda.Runtime.NODEJS_LATEST,
      environment: {
        NAMESPACE_ID: namespace.namespaceId,
        ALLOWED_CLUSTER_ARNS: `${proxyCluster.clusterArn},${serviceCluster.clusterArn}`,
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
    });

    discovery.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "servicediscovery:CreateService",
          "servicediscovery:ListServices",
          "servicediscovery:RegisterInstance",
          "servicediscovery:DeregisterInstance",
          "servicediscovery:GetInstance",
        ],
        resources: ["*"],
      }),
    );

    const autoscaler = new NodejsFunction(this, "Autoscaler", {
      entry: "lib/lambdas/autoscaler.ts",
      runtime: lambda.Runtime.NODEJS_LATEST,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
    });

    autoscaler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ecs:ListTasks",
          "ecs:ListContainerInstances",
          "ecs:DescribeContainerInstances",
          "ecs:DescribeTasks",
        ],
        resources: ["*"],
      }),
    );

    autoscaler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "autoscaling:DescribeAutoScalingGroups",
          "autoscaling:SetDesiredCapacity",
          "autoscaling:SetInstanceProtection",
        ],
        resources: ["*"],
      }),
    );

    const taskStateChangeRule = new events.Rule(
      this,
      "ECSTaskStateChangeRule",
      {
        eventPattern: {
          source: ["aws.ecs"],
          detailType: ["ECS Task State Change"],
          detail: {
            lastStatus: ["RUNNING", "STOPPED"],
          },
        },
      },
    );

    taskStateChangeRule.addTarget(new targets.LambdaFunction(discovery));
    taskStateChangeRule.addTarget(new targets.LambdaFunction(autoscaler));

    // todo: auto cleanup ecs tasks when no requests for some time
    // todo: auto cleanup fargate tasks when no requests for some time

    new cdk.CfnOutput(this, "WrapperUrl", {
      value: wrapper.url,
    });
  }
}
