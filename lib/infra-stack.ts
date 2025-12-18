import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Nextjs } from "cdk-nextjs-standalone";
import { Networking } from "./constructs/networking";
import { Containers } from "./constructs/containers";
import { Automation } from "./constructs/automation";

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const networking = new Networking(this, "Networking");

    const containers = new Containers(this, "Containers", {
      networking,
    });

    const automation = new Automation(this, "Automation", {
      networking,
      containers,
    });

    // DynamoDB table for service launch locks
    const launchLocksTable = new dynamodb.Table(this, "LaunchLocks", {
      partitionKey: {
        name: "serviceName",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const publicSubnets = networking.vpc.publicSubnets.map(
      (subnet) => subnet.subnetId,
    );
    const privateSubnets = networking.vpc.privateSubnets.map(
      (subnet) => subnet.subnetId,
    );

    const wrapper = new Nextjs(this, "Wrapper", {
      nextjsPath: "./lib/wrapper",
      environment: {
        DOMAIN: networking.hostedZone.zoneName,
        PROXY_CLUSTER: containers.proxyCluster.clusterName,
        SERVICE_CLUSTER: containers.serviceCluster.clusterName,
        PROXY_TASK_DEFINITION: containers.proxyTaskDefinition.taskDefinitionArn,
        SERVICE_TASK_DEFINITION:
          containers.serviceTaskDefinition.taskDefinitionArn,
        PROXY_SUBNET_IDS: publicSubnets.join(","),
        SERVICE_SUBNET_IDS: privateSubnets.join(","),
        SECURITY_GROUP_ID: networking.securityGroup.securityGroupId,
        SERVICE_ASG_NAME:
          containers.serviceAutoScalingGroup.autoScalingGroupName,
        PROXY_CONTAINER_NAME: Containers.PROXY_CONTAINER_NAME,
        SERVICE_CONTAINER_NAME: Containers.SERVICE_CONTAINER_NAME,
        HOSTED_ZONE_ID: networking.hostedZone.hostedZoneId,
        LAUNCH_LOCKS_TABLE_NAME: launchLocksTable.tableName,
      },
    });

    const cfnFunction = wrapper.serverFunction.lambdaFunction.node
      .defaultChild as lambda.CfnFunction;
    // Timeout increased to 15 minutes to handle:
    // - EC2 instance scaling (up to 3 minutes)
    // - Task launches (up to 5 minutes)
    // - DNS propagation wait (up to 90 seconds)
    // - Buffer for network delays
    cfnFunction.timeout = 900; // 15 minutes

    wrapper.serverFunction.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ecs:RunTask",
          "ecs:StopTask",
          "ecs:ListTasks",
          "ecs:DescribeTasks",
          "ecs:ListContainerInstances",
          "ecs:DescribeContainerInstances",
        ],
        resources: ["*"],
      }),
    );

    wrapper.serverFunction.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [
          containers.proxyTaskDefinition.taskRole.roleArn,
          containers.proxyTaskDefinition.executionRole?.roleArn || "",
          containers.serviceTaskDefinition.taskRole.roleArn,
          containers.serviceTaskDefinition.executionRole?.roleArn || "",
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

    // Grant DynamoDB permissions
    launchLocksTable.grantReadWriteData(wrapper.serverFunction.lambdaFunction);

    // Grant autoscaler access to lock table for distributed locking
    launchLocksTable.grantReadWriteData(automation.autoscaler);
    automation.autoscaler.addEnvironment(
      "LAUNCH_LOCKS_TABLE_NAME",
      launchLocksTable.tableName,
    );

    new cdk.CfnOutput(this, "WrapperUrl", {
      value: wrapper.url,
    });
  }
}
