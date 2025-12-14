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

    const securityGroup = new ec2.SecurityGroup(this, "TaskSecurityGroup", {
      vpc,
      description: "Security group for ECS tasks",
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(9050),
      "Allow service container port",
    );
    securityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(9060),
      "Allow proxy container port",
    );

    const namespace = new dns.PrivateDnsNamespace(this, "Namespace", {
      name: "local",
      vpc,
    });

    const proxy = new ecs.FargateTaskDefinition(this, "ProxyTaskDef", {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    proxy.addContainer("ProxyContainer", {
      image: ecs.ContainerImage.fromAsset("lib/proxy"),
      portMappings: [{ containerPort: 9060 }],
      environment: {
        NAMESPACE: namespace.namespaceName,
      },
    });

    const service = new ecs.Ec2TaskDefinition(this, "ServiceTaskDef", {
      networkMode: ecs.NetworkMode.AWS_VPC,
    });

    service.addContainer("ServiceContainer", {
      image: ecs.ContainerImage.fromAsset("lib/service"),
      portMappings: [{ containerPort: 9050 }],
      memoryLimitMiB: 512,
      environment: {
        NAMESPACE: namespace.namespaceName,
      },
    });

    const publicSubnets = vpc.publicSubnets.map((subnet) => subnet.subnetId);
    const privateSubnets = vpc.privateSubnets.map((subnet) => subnet.subnetId);

    const wrapper = new Nextjs(this, "Wrapper", {
      nextjsPath: "./lib/wrapper",
      environment: {
        NAMESPACE: namespace.namespaceName,
        PROXY_CLUSTER: proxyCluster.clusterName,
        SERVICE_CLUSTER: serviceCluster.clusterName,
        PROXY_TASK_DEFINITION: proxy.taskDefinitionArn,
        SERVICE_TASK_DEFINITION: service.taskDefinitionArn,
        PROXY_SUBNET_IDS: publicSubnets.join(","),
        SERVICE_SUBNET_IDS: privateSubnets.join(","),
        SECURITY_GROUP_ID: securityGroup.securityGroupId,
      },
    });

    wrapper.serverFunction.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ecs:RunTask",
          "ecs:ListTasks",
          "ecs:DescribeTasks",
          "ecs:ListContainerInstances",
        ],
        resources: ["*"],
      }),
    );

    wrapper.serverFunction.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [
          proxy.taskRole.roleArn,
          proxy.executionRole?.roleArn || "",
          service.taskRole.roleArn,
          service.executionRole?.roleArn || "",
        ].filter(Boolean),
      }),
    );

    wrapper.serverFunction.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "autoscaling:DescribeAutoScalingGroups",
          "autoscaling:SetDesiredCapacity",
        ],
        resources: ["*"],
      }),
    );

    wrapper.serverFunction.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ec2:DescribeNetworkInterfaces"],
        resources: ["*"],
      }),
    );

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

    new cdk.CfnOutput(this, "WrapperUrl", {
      value: wrapper.url,
    });
  }
}
