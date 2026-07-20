import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serviceFiles = {
  web: new URL("../deploy/pdf-checker.service", import.meta.url),
  worker: new URL("../deploy/pdf-checker-worker.service", import.meta.url),
};

async function readServices() {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(serviceFiles).map(async ([name, file]) => [name, await readFile(file, "utf8")]),
    ),
  );
}

function serviceSettings(source) {
  const settings = new Map();
  let section = "";

  for (const line of source.split(/\r?\n/)) {
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1];
      continue;
    }
    if (section !== "Service" || !line || line.startsWith("#")) continue;
    const setting = line.match(/^([^=]+)=(.*)$/);
    if (!setting) continue;
    const [, key, value] = setting;
    const values = settings.get(key) ?? [];
    values.push(value);
    settings.set(key, values);
  }

  return settings;
}

test("web and worker units share one hardened private data boundary", async () => {
  const services = await readServices();
  const required = {
    User: "ubuntu",
    Group: "ubuntu",
    WorkingDirectory: "/opt/pdf-checker/current",
    EnvironmentFile: "/etc/pdf-checker.env",
    UMask: "0077",
    NoNewPrivileges: "true",
    PrivateTmp: "true",
    ProtectSystem: "strict",
    ProtectHome: "true",
    ReadWritePaths: "/var/lib/pdf-checker",
  };

  for (const [name, source] of Object.entries(services)) {
    const settings = serviceSettings(source);
    for (const [key, expected] of Object.entries(required)) {
      assert.deepEqual(settings.get(key), [expected], `${name} must define exactly one ${key}=${expected}`);
    }
    assert.equal(settings.has("DynamicUser"), false, `${name} must use the explicit ubuntu service account`);
    assert.doesNotMatch(source, /^EnvironmentFile=-/m, `${name} must fail fast when /etc/pdf-checker.env is missing`);
    assert.doesNotMatch(source, /(DASHSCOPE|API[_-]?KEY|SECRET|TOKEN)=/i, `${name} must not contain a credential`);
  }
});

test("worker starts the built artifact independently and web retains its web command", async () => {
  const { web, worker } = await readServices();
  const workerSettings = serviceSettings(worker);
  const webSettings = serviceSettings(web);

  assert.deepEqual(workerSettings.get("ExecStart"), ["/usr/local/bin/node /opt/pdf-checker/current/dist/audit-worker.mjs"]);
  assert.deepEqual(workerSettings.get("Restart"), ["on-failure"]);
  assert.deepEqual(workerSettings.get("RestartSec"), ["5"]);
  assert.deepEqual(workerSettings.get("TimeoutStopSec"), ["30"]);
  assert.match(worker, /^WantedBy=multi-user\.target$/m);
  assert.deepEqual(webSettings.get("ExecStart"), ["/usr/local/bin/node scripts/run-vinext.mjs start"]);
  assert.equal(web.includes("pdf-checker-worker.service"), false, "web must not depend on a successful worker start");
});

test("nginx and operations documentation preserve upload, installation, and secret-safe procedures", async () => {
  const [nginx, readme, deploymentDesign] = await Promise.all([
    readFile(new URL("../deploy/nginx-pdf-checker.conf", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/superpowers/specs/2026-07-18-github-main-tencent-deployment-design.md", import.meta.url), "utf8"),
  ]);
  const documentation = `${readme}\n${deploymentDesign}`;

  assert.match(nginx, /^\s*client_max_body_size\s+25m;$/m);
  for (const command of [
    "sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/pdf-checker",
    "sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/pdf-checker/data",
    "sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/pdf-checker/uploads",
    "sudo systemctl enable --now pdf-checker.service pdf-checker-worker.service",
  ]) {
    assert.match(documentation, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const value of [
    "PDF_AUDIT_DATA_DIR=/var/lib/pdf-checker",
    "PDF_AUDIT_PDF_RETENTION_HOURS=72",
    "PDF_AUDIT_WORKER_CONCURRENCY=3",
    "PDF_AUDIT_WORKER_POLL_MS=1000",
    "PDF_AUDIT_SINGLE_TENANT_OWNER=shared-server",
  ]) {
    assert.match(documentation, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(documentation, /PDF_AUDIT_REQUIRE_AUTH=false/);
  assert.match(documentation, /oai-authenticated-user-email/);
  assert.match(documentation, /journalctl[^\n]*-n 100[^\n]*--no-pager/);
  assert.doesNotMatch(documentation, /^\s*(?:sudo\s+)?cat\s+\/etc\/pdf-checker\.env\s*$/m);
  assert.match(documentation, /sqlite3[^\n]*\.backup|systemctl stop[^\n]*pdf-checker/);
  assert.match(documentation, /not acceptable for a public or multi-user deployment|不适用于公开或多用户部署/i);
  assert.match(documentation, /dist\/audit-worker\.mjs/);
});
