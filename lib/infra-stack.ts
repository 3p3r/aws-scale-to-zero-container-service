import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
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

    const publicSubnets = networking.vpc.publicSubnets.map(
      (subnet) => subnet.subnetId,
    );
    const privateSubnets = networking.vpc.privateSubnets.map(
      (subnet) => subnet.subnetId,
    );

    const wrapper = new Nextjs(this, "Wrapper", {
      nextjsPath: "./lib/wrapper",
      environment: {
        NAMESPACE: networking.namespace.namespaceName,
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

    wrapper.serverFunction.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ec2:DescribeNetworkInterfaces"],
        resources: ["*"],
      }),
    );

    new cdk.CfnOutput(this, "WrapperUrl", {
      value: wrapper.url,
    });
  }
}
