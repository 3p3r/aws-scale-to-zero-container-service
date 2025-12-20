import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import delay from "delay";

const execAsync = promisify(exec);

const upstreamHost = process.env.UPSTREAM_HOST;
if (!upstreamHost) {
  console.log(
    "UPSTREAM_HOST not set, health check disabled - exiting gracefully",
  );
  process.exit(0);
}

const upstreamPort = process.env.UPSTREAM_PORT || "9050";
const healthCheckUrl = `http://${upstreamHost}:${upstreamPort}`;
const maxFailures = parseInt(process.env.MAX_HEALTH_CHECK_FAILURES || "5", 10);
const baseInterval = parseInt(
  process.env.HEALTH_CHECK_BASE_INTERVAL || "5000",
  10,
);
const initialGracePeriod = parseInt(
  process.env.HEALTH_CHECK_INITIAL_GRACE_PERIOD_MS || "600000",
  10,
); // 10 minutes default - EC2 instances need time to spin up from 0
const SUPERVISOR_PID_FILE = "/var/run/supervisord.pid";

let consecutiveFailures = 0;
let isShuttingDown = false;

console.log(`Starting health check for: ${healthCheckUrl}`);
console.log(`Max consecutive failures: ${maxFailures}`);
console.log(`Base check interval: ${baseInterval}ms`);
console.log(
  `Initial grace period: ${initialGracePeriod}ms (${initialGracePeriod / 1000}s)`,
);

async function performHealthCheck(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `curl -f -s -o /dev/null -w "%{http_code}" --max-time 3 --connect-timeout 2 ${healthCheckUrl}`,
    );
    const httpCode = parseInt(stdout.trim(), 10);
    return httpCode >= 200 && httpCode < 400;
  } catch (error) {
    return false;
  }
}

async function shutdown() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.error(
    `Health check failed ${maxFailures} times consecutively. Shutting down proxy container...`,
  );
  try {
    if (existsSync(SUPERVISOR_PID_FILE)) {
      const pid = readFileSync(SUPERVISOR_PID_FILE, "utf-8").trim();
      await execAsync(`kill -TERM ${pid}`);
    } else {
      await execAsync("pkill -TERM supervisord");
    }
  } catch (error) {
    console.error("Error killing supervisord:", error);
  }
  process.exit(1);
}

async function performHealthCheckWithRetry(): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const isHealthy = await performHealthCheck();
    if (isHealthy) {
      return true;
    }
    if (attempt < 4) {
      await delay(1000);
    }
  }
  return false;
}

async function runHealthCheckWithBackoff(): Promise<boolean> {
  const isHealthy = await performHealthCheckWithRetry();

  if (!isHealthy) {
    consecutiveFailures++;
    console.log(
      `Health check failed (${consecutiveFailures}/${maxFailures} consecutive failures)`,
    );

    if (consecutiveFailures >= maxFailures) {
      await shutdown();
      return false;
    }

    return false;
  }

  if (consecutiveFailures > 0) {
    console.log(
      `Health check passed (was ${consecutiveFailures} consecutive failures)`,
    );
  }
  consecutiveFailures = 0;
  return true;
}

async function startHealthChecks() {
  await delay(initialGracePeriod);

  while (!isShuttingDown) {
    const isHealthy = await runHealthCheckWithBackoff();

    if (isShuttingDown) {
      break;
    }

    await delay(baseInterval);
  }
}

startHealthChecks().catch((error) => {
  console.error("Fatal error in health check loop:", error);
  process.exit(1);
});
process.on("SIGTERM", () => {
  isShuttingDown = true;
  process.exit(0);
});

process.on("SIGINT", () => {
  isShuttingDown = true;
  process.exit(0);
});
