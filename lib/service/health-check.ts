import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { backOff } from "exponential-backoff";

const execAsync = promisify(exec);

const serviceName = process.env.SERVICE_NAME;
if (!serviceName) {
  throw new Error("SERVICE_NAME environment variable is required");
}

const proxyHost = process.env.PROXY_HOST || `${serviceName}.proxy.local`;
const proxyPort = process.env.PROXY_PORT || "9060";
const healthCheckUrl = `http://${proxyHost}:${proxyPort}`;
const maxFailures = parseInt(process.env.MAX_HEALTH_CHECK_FAILURES || "5", 10);
const baseInterval = parseInt(
  process.env.HEALTH_CHECK_BASE_INTERVAL || "5000",
  10,
);
const initialGracePeriod = parseInt(
  process.env.HEALTH_CHECK_INITIAL_GRACE_PERIOD_MS || "60000",
  10,
); // 1 minute default (proxy usually starts faster)
const maxDelay = parseInt(process.env.HEALTH_CHECK_MAX_DELAY_MS || "30000", 10);
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
    `Health check failed ${maxFailures} times consecutively. Shutting down service container...`,
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

async function runHealthCheckWithBackoff(): Promise<boolean> {
  try {
    return await backOff(
      async () => {
        const isHealthy = await performHealthCheck();
        if (!isHealthy) {
          consecutiveFailures++;
          console.log(
            `Health check failed (${consecutiveFailures}/${maxFailures} consecutive failures)`,
          );
          throw new Error("Health check failed");
        }
        // Health check passed
        if (consecutiveFailures > 0) {
          console.log(
            `Health check passed (was ${consecutiveFailures} consecutive failures)`,
          );
        }
        consecutiveFailures = 0;
        return true;
      },
      {
        numOfAttempts: maxFailures,
        startingDelay: baseInterval,
        timeMultiple: 2,
        maxDelay: maxDelay,
        jitter: "full",
        retry: () => {
          if (consecutiveFailures >= maxFailures) {
            return false; // Stop retrying, will shutdown
          }
          return true; // Continue retrying
        },
      },
    );
  } catch (error) {
    // All retries exhausted
    if (consecutiveFailures >= maxFailures) {
      await shutdown();
      return false;
    }
    return false;
  }
}

async function startHealthChecks() {
  // Wait for initial grace period before starting health checks
  // This gives time for the proxy to launch and register with service discovery
  console.log(
    `Waiting ${initialGracePeriod}ms grace period before starting health checks...`,
  );
  await new Promise((resolve) => setTimeout(resolve, initialGracePeriod));
  console.log("Grace period complete, starting health checks");

  while (!isShuttingDown) {
    const isHealthy = await runHealthCheckWithBackoff();

    if (isShuttingDown) {
      break;
    }

    if (isHealthy) {
      await new Promise((resolve) => setTimeout(resolve, baseInterval));
    }
    // If unhealthy, backOff already handled the retries and delays
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
