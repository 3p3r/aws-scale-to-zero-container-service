import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
} from "@aws-sdk/client-route-53";

if (process.env.SKIP_DNS_REGISTRATION === "true") {
  process.exit(0);
}

const serviceName = process.env.SERVICE_NAME;
const hostedZoneId = process.env.HOSTED_ZONE_ID;
const domain = process.env.DOMAIN;

if (!serviceName || !hostedZoneId || !domain) {
  process.exit(0);
}

async function getPublicIp(): Promise<string> {
  const endpoints = [
    "http://checkip.amazonaws.com",
    "http://169.254.169.254/latest/meta-data/public-ipv4",
    "http://icanhazip.com",
  ];

  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(endpoint, { signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok) {
        const ip = (await response.text()).trim();
        return ip;
      }
    } catch (error) {
      // Continue to next endpoint
    }
  }

  throw new Error("Could not determine public IP from any endpoint");
}

async function registerDns() {
  const route53 = new Route53Client();
  const publicIp = await getPublicIp();
  const recordName = `${serviceName}.${domain}`;

  await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: recordName,
              Type: "A",
              TTL: 60,
              ResourceRecords: [{ Value: publicIp }],
            },
          },
        ],
      },
    }),
  );
}

registerDns()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Failed to register DNS:", error);
    process.exit(0);
  });
