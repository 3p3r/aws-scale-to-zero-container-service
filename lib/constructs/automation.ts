import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Networking } from "./networking";
import { Containers } from "./containers";

export interface AutomationProps {
  networking: Networking;
  containers: Containers;
}

export class Automation extends Construct {
  public readonly discovery: NodejsFunction;
  public readonly autoscaler: NodejsFunction;
  public readonly taskStateChangeRule: events.Rule;

  constructor(scope: Construct, id: string, props: AutomationProps) {
    super(scope, id);

    this.discovery = new NodejsFunction(this, "Discovery", {
      entry: "lib/lambdas/discovery.ts",
      runtime: lambda.Runtime.NODEJS_LATEST,
      environment: {
        NAMESPACE_ID: props.networking.namespace.namespaceId,
        ALLOWED_CLUSTER_ARNS: `${props.containers.proxyCluster.clusterArn},${props.containers.serviceCluster.clusterArn}`,
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
    });

    this.discovery.addToRolePolicy(
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

    this.autoscaler = new NodejsFunction(this, "Autoscaler", {
      entry: "lib/lambdas/autoscaler.ts",
      runtime: lambda.Runtime.NODEJS_LATEST,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
    });

    this.autoscaler.addToRolePolicy(
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

    this.autoscaler.addToRolePolicy(
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

    this.taskStateChangeRule = new events.Rule(this, "ECSTaskStateChangeRule", {
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Task State Change"],
        detail: {
          lastStatus: ["RUNNING", "STOPPED"],
        },
      },
    });

    this.taskStateChangeRule.addTarget(
      new targets.LambdaFunction(this.discovery),
    );
    this.taskStateChangeRule.addTarget(
      new targets.LambdaFunction(this.autoscaler),
    );
  }
}
