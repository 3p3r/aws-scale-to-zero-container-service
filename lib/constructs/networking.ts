import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Containers } from "./containers";

export class Networking extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly hostedZone: route53.IHostedZone;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const domain = this.node.tryGetContext("domain") || "example.com";

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
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    this.hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: domain,
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

    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(Containers.PROXY_PORT),
      "Allow Internet access to proxy container port",
    );
  }
}
