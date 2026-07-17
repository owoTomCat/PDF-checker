import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const allowedActions = new Set(["dev", "build", "start"]);
const action = process.argv[2];

if (!action || !allowedActions.has(action) || process.argv.length !== 3) {
  console.error("Usage: node scripts/run-vinext.mjs dev|build|start");
  process.exit(2);
}

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const executable = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vinext.cmd" : "vinext",
);
const command =
  process.platform === "win32"
    ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
    : executable;
const commandArguments =
  process.platform === "win32"
    ? ["/d", "/s", "/c", `"${executable}" ${action}`]
    : [action];
const child = spawn(command, commandArguments, {
  cwd: projectRoot,
  env: {
    ...process.env,
    WRANGLER_LOG_PATH:
      process.env.WRANGLER_LOG_PATH ?? ".wrangler/wrangler.log",
  },
  stdio: "inherit",
  windowsVerbatimArguments: process.platform === "win32",
});

child.once("error", (error) => {
  console.error(`Unable to start vinext: ${error.message}`);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  if (signal) {
    try {
      process.kill(process.pid, signal);
      return;
    } catch {
      process.exit(1);
    }
  }
  process.exit(code ?? 1);
});
