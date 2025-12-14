import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";

const execAsync = promisify(exec);

const serviceName = process.env.SERVICE_NAME;
if (!serviceName) {
  throw new Error("SERVICE_NAME environment variable is required");
}

const upstreamHost =
  process.env.UPSTREAM_HOST || `${serviceName}.service.local`;
const upstreamPort = process.env.UPSTREAM_PORT || "9050";
const healthCheckUrl = `http://${upstreamHost}:${upstreamPort}`;
const maxFailures = parseInt(process.env.MAX_HEALTH_CHECK_FAILURES || "5", 10);
const initialDelay = parseInt(
  process.env.HEALTH_CHECK_INITIAL_DELAY || "2000",
  10,
);
const baseInterval = parseInt(
  process.env.HEALTH_CHECK_BASE_INTERVAL || "5000",
  10,
);
const maxDelay = parseInt(process.env.HEALTH_CHECK_MAX_DELAY || "30000", 10);
const SUPERVISOR_PID_FILE = "/var/run/supervisord.pid";

let consecutiveFailures = 0;
let isShuttingDown = false;

console.log(`Starting health check for: ${healthCheckUrl}`);
console.log(`Max consecutive failures: ${maxFailures}`);
console.log(`Base check interval: ${baseInterval}ms, Max delay: ${maxDelay}ms`);

async function performHealthCheck(): Promise<boolean> {
  try {
    await execAsync(`curl -f -s -o /dev/null --max-time 3 ${healthCheckUrl}`);
    return true;
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

async function runHealthCheck(): Promise<boolean> {
  try {
    const isHealthy = await performHealthCheck();

    if (isHealthy) {
      if (consecutiveFailures > 0) {
        console.log(
          `Health check passed (was ${consecutiveFailures} consecutive failures)`,
        );
      }
      consecutiveFailures = 0;
      return true;
    } else {
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
  } catch (error) {
    console.error("Error in health check:", error);
    return true;
  }
}

function calculateBackoffDelay(failureCount: number): number {
  const delay = baseInterval * Math.pow(2, failureCount - 1);
  return Math.min(delay, maxDelay);
}

async function startHealthChecks() {
  await new Promise((resolve) => setTimeout(resolve, initialDelay));

  while (!isShuttingDown) {
    const isHealthy = await runHealthCheck();

    if (isShuttingDown) {
      break;
    }

    if (isHealthy) {
      await new Promise((resolve) => setTimeout(resolve, baseInterval));
    } else {
      const delay = calculateBackoffDelay(consecutiveFailures);
      console.log(
        `Waiting ${delay}ms before next health check (exponential backoff)`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
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
