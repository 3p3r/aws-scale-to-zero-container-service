import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
} from "@aws-sdk/client-route-53";

// Skip DNS registration in local development
if (process.env.SKIP_DNS_REGISTRATION === "true") {
  console.log("Skipping DNS registration (local development)");
  process.exit(0);
}

const serviceName = process.env.SERVICE_NAME;
const hostedZoneId = process.env.HOSTED_ZONE_ID;
const domain = process.env.DOMAIN;

console.log(
  `DNS Registration config: serviceName=${serviceName}, hostedZoneId=${hostedZoneId}, domain=${domain}`,
);

if (!serviceName || !hostedZoneId || !domain) {
  console.error(
    "Missing required env vars: SERVICE_NAME, HOSTED_ZONE_ID, DOMAIN - continuing without DNS registration",
  );
  // Don't exit with error - allow the container to continue running
  process.exit(0);
}

async function getPublicIp(): Promise<string> {
  // Try multiple endpoints in case one fails
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
        console.log(`Got public IP from ${endpoint}: ${ip}`);
        return ip;
      }
    } catch (error) {
      console.log(`Failed to get IP from ${endpoint}: ${error}`);
    }
  }

  throw new Error("Could not determine public IP from any endpoint");
}

async function registerDns() {
  const route53 = new Route53Client();
  const publicIp = await getPublicIp();
  const recordName = `${serviceName}.${domain}`;

  console.log(`Registering ${recordName} -> ${publicIp}`);

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

  console.log(`DNS registered: ${recordName} -> ${publicIp}`);
}

registerDns()
  .then(() => {
    console.log("DNS registration complete");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Failed to register DNS:", error);
    // Don't exit with error code - allow container to continue
    // The proxy can still work, just won't be accessible via DNS name
    console.log("Continuing without DNS registration");
    process.exit(0);
  });
