import * as cdk from "aws-cdk-lib/core";
import type { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as dns from "aws-cdk-lib/aws-servicediscovery";
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
      name: "service.local",
      vpc,
    });

    const proxy = new ecs.FargateTaskDefinition(this, "ProxyTaskDef", {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    const proxyContainer = proxy.addContainer("ProxyContainer", {
      image: ecs.ContainerImage.fromRegistry("nginx:latest"), // todo
      portMappings: [{ containerPort: 9060 }],
      environment: {
        NAMESPACE: namespace.namespaceName,
      },
    });

    const service = new ecs.Ec2TaskDefinition(this, "ServiceTaskDef", {
      networkMode: ecs.NetworkMode.AWS_VPC,
    });

    const serviceContainer = service.addContainer("ServiceContainer", {
      image: ecs.ContainerImage.fromRegistry("amazonlinux:2"), // todo
      portMappings: [{ containerPort: 9050 }],
      environment: {
        NAMESPACE: namespace.namespaceName,
      },
    });

    proxyContainer.addEnvironment("SERVICE_TASK", service.taskDefinitionArn);
    serviceContainer.addEnvironment("PROXY_TASK", proxy.taskDefinitionArn);

    const wrapper = new Nextjs(this, "Wrapper", {
      nextjsPath: "./wrapper",
      environment: {
        NAMESPACE: namespace.namespaceName,
        PROXY_CLUSTER: proxyCluster.clusterName,
        SERVICE_CLUSTER: serviceCluster.clusterName,
      },
    });

    new cdk.CfnOutput(this, "WrapperUrl", {
      value: wrapper.url,
    });
  }
}
