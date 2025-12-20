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
        LAUNCH_LOCKS_TABLE_NAME: launchLocksTable.tableName,
      },
    });

    const cfnFunction = wrapper.serverFunction.lambdaFunction.node
      .defaultChild as lambda.CfnFunction;
    cfnFunction.timeout = 900;

    wrapper.serverFunction.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ecs:RunTask",
          "ecs:ListTasks",
          "ecs:DescribeTasks",
          "ecs:ListContainerInstances",
          "ecs:DescribeContainerInstances",
        ],
        resources: ["*"],
      }),
    );

    const passRoleArns = [
      containers.proxyTaskDefinition.taskRole.roleArn,
      containers.proxyTaskDefinition.executionRole?.roleArn,
      containers.serviceTaskDefinition.taskRole.roleArn,
      containers.serviceTaskDefinition.executionRole?.roleArn,
    ].filter((arn): arn is string => Boolean(arn));

    wrapper.serverFunction.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: passRoleArns,
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

    launchLocksTable.grantReadWriteData(wrapper.serverFunction.lambdaFunction);
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
