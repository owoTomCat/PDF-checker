import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve();
const vinextCli = path.join(projectRoot, "node_modules", "vinext", "dist", "cli.js");

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(url, child, diagnostics) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`production server exited before becoming ready\n${diagnostics()}`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`production server did not become ready\n${diagnostics()}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (!child.kill("SIGTERM")) return;
  let timeout;
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), 3_000);
    }),
  ]);
  clearTimeout(timeout);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

test("production server admits a 20 MiB PDF and preserves the application file limit", async () => {
  const builtServer = await readFile(path.join(projectRoot, "dist", "server", "index.js"), "utf8");
  assert.match(builtServer, /var __MAX_ACTION_BODY_SIZE = 1048576;/);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-production-upload-"));
  let child;
  let diagnostics = "";

  try {
    const port = await reservePort();
    child = spawn(process.execPath, [
      vinextCli,
      "start",
      "--port",
      String(port),
      "--hostname",
      "127.0.0.1",
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PDF_AUDIT_DATA_DIR: dataDir,
        PDF_AUDIT_REQUIRE_AUTH: "false",
        PDF_AUDIT_SINGLE_TENANT_OWNER: "production-upload-test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const spawnFailure = new Promise((_, reject) => child.once("error", reject));
    const appendDiagnostics = (chunk) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-4_000);
    };
    child.stdout.on("data", appendDiagnostics);
    child.stderr.on("data", appendDiagnostics);
    const tasksUrl = `http://127.0.0.1:${port}/api/tasks`;
    await Promise.race([
      waitForServer(tasksUrl, child, () => diagnostics),
      spawnFailure,
    ]);

    const pdfBytes = new Uint8Array(20 * 1024 * 1024);
    pdfBytes.set(new TextEncoder().encode("%PDF-1.7\n"));
    const encodedFileName = encodeURIComponent("最大 文件.pdf");

    const response = await fetch(tasksUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-Pdf-File-Name": encodedFileName,
      },
      body: new File([pdfBytes], "maximum.pdf", { type: "application/pdf" }),
    });
    assert.equal(response.status, 202);
    const task = await response.json();
    assert.equal(task.status, "queued");
    assert.equal(task.fileName, "最大 文件.pdf");

    const oversizedResponse = await fetch(tasksUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-Pdf-File-Name": encodedFileName,
      },
      body: new File(
        [pdfBytes, new Uint8Array(1)],
        "oversized.pdf",
        { type: "application/pdf" },
      ),
    });
    assert.equal(oversizedResponse.status, 413);
    assert.match(oversizedResponse.headers.get("content-type") ?? "", /^application\/json\b/);
    const oversizedError = await oversizedResponse.json();
    assert.equal(oversizedError.error?.code, "PDF_TOO_LARGE");
  } finally {
    await stopChild(child);
    await rm(dataDir, { recursive: true, force: true });
  }
});
