import { existsSync, readFileSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const SHUTDOWN_FILE = "/tmp/shutdown";
const SUPERVISOR_PID_FILE = "/var/run/supervisord.pid";
const CHECK_INTERVAL = 1000;

console.log(`Watching for shutdown file: ${SHUTDOWN_FILE}`);

let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

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
  process.exit(0);
}

if (existsSync(SHUTDOWN_FILE)) {
  console.log("Shutdown file found on startup, shutting down...");
  shutdown();
}

const pollInterval = setInterval(async () => {
  if (existsSync(SHUTDOWN_FILE) && !isShuttingDown) {
    console.log("Shutdown file detected, initiating container shutdown...");
    clearInterval(pollInterval);
    await shutdown();
  }
}, CHECK_INTERVAL);
process.on("SIGTERM", () => {
  clearInterval(pollInterval);
  process.exit(0);
});

process.on("SIGINT", () => {
  clearInterval(pollInterval);
  process.exit(0);
});
