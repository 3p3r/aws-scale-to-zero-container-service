import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Networking } from "./networking";
import type { Containers } from "./containers";

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
        HOSTED_ZONE_ID: props.networking.hostedZone.hostedZoneId,
        DOMAIN: props.networking.hostedZone.zoneName,
        ALLOWED_CLUSTER_ARNS: `${props.containers.proxyCluster.clusterArn},${props.containers.serviceCluster.clusterArn}`,
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      bundling: {
        externalModules: ["@aws-sdk/*"],
      },
    });

    this.discovery.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "route53:ChangeResourceRecordSets",
          "route53:ListResourceRecordSets",
        ],
        resources: [props.networking.hostedZone.hostedZoneArn],
      }),
    );

    this.autoscaler = new NodejsFunction(this, "Autoscaler", {
      entry: "lib/lambdas/autoscaler.ts",
      runtime: lambda.Runtime.NODEJS_LATEST,
      environment: {
        SERVICE_CLUSTER: props.containers.serviceCluster.clusterName,
        SERVICE_ASG_NAME:
          props.containers.serviceAutoScalingGroup.autoScalingGroupName,
        MAX_TASKS_PER_INSTANCE: "3",
        // LAUNCH_LOCKS_TABLE_NAME will be set by InfraStack after table creation
      },
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      bundling: {
        externalModules: ["@aws-sdk/*"],
      },
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

    const scheduledRule = new events.Rule(this, "AutoscalerScheduledRule", {
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
    });

    scheduledRule.addTarget(new targets.LambdaFunction(this.autoscaler));
  }
}
