import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as dns from "aws-cdk-lib/aws-servicediscovery";
import { Containers } from "./containers";

export interface NetworkingProps {
  namespaceName?: string;
}

export class Networking extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly namespace: dns.PrivateDnsNamespace;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: NetworkingProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "Vpc", {
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

    this.namespace = new dns.PrivateDnsNamespace(this, "Namespace", {
      name: props?.namespaceName || "local",
      vpc: this.vpc,
    });

    this.securityGroup = new ec2.SecurityGroup(this, "TaskSecurityGroup", {
      vpc: this.vpc,
      description: "Security group for ECS tasks",
      allowAllOutbound: true,
    });

    this.securityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(Containers.SERVICE_PORT),
      "Allow service container port",
    );
    this.securityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(Containers.PROXY_PORT),
      "Allow proxy container port",
    );
  }
}
