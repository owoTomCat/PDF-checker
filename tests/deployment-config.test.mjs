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
  assert.deepEqual(workerSettings.get("TimeoutStopSec"), ["120"]);
  assert.match(worker, /^WantedBy=multi-user\.target$/m);
  assert.deepEqual(webSettings.get("ExecStart"), ["/usr/local/bin/node scripts/run-vinext.mjs start --hostname 127.0.0.1"]);
  assert.equal(web.includes("pdf-checker-worker.service"), false, "web must not depend on a successful worker start");
});

test("nginx and operations documentation preserve upload, installation, and secret-safe procedures", async () => {
  const [nginx, readme, deploymentDesign, implementationPlan, launcher] = await Promise.all([
    readFile(new URL("../deploy/nginx-pdf-checker.conf", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/superpowers/specs/2026-07-18-github-main-tencent-deployment-design.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/superpowers/plans/2026-07-20-server-side-pdf-processing.md", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-vinext.mjs", import.meta.url), "utf8"),
  ]);
  const documentation = `${readme}\n${deploymentDesign}\n${implementationPlan}`;

  assert.match(nginx, /^\s*client_max_body_size\s+25m;$/m);
  const uploadMap = nginx.match(
    /map\s+"\$request_method:\$uri"\s+\$pdf_upload_limit_key\s*\{([\s\S]*?)\}/,
  );
  assert.ok(uploadMap, "Nginx must derive an upload-only rate/connection key");
  assert.match(uploadMap[1], /^\s*default\s+"";$/m);
  assert.match(uploadMap[1], /^\s*"POST:\/api\/tasks"\s+\$binary_remote_addr;$/m);
  assert.doesNotMatch(uploadMap[1], /GET:|\/api\/audit|batch-delete|\/retry/);
  assert.match(
    nginx,
    /^\s*limit_conn_zone\s+\$pdf_upload_limit_key\s+zone=pdf_upload_conn:10m;$/m,
  );
  assert.match(
    nginx,
    /^\s*limit_req_zone\s+\$pdf_upload_limit_key\s+zone=pdf_upload_rate:10m\s+rate=6r\/s;$/m,
  );
  assert.match(nginx, /^\s*limit_conn\s+pdf_upload_conn\s+3;$/m);
  assert.match(nginx, /^\s*limit_conn_status\s+429;$/m);
  assert.match(nginx, /^\s*limit_req\s+zone=pdf_upload_rate\s+burst=12\s+nodelay;$/m);
  assert.match(nginx, /^\s*limit_req_status\s+429;$/m);
  assert.match(nginx, /^\s*proxy_set_header\s+oai-authenticated-user-email\s+"";$/m);
  assert.match(
    nginx,
    /^\s*proxy_set_header\s+X-Pdf-File-Name\s+\$http_x_pdf_file_name;$/m,
  );
  assert.doesNotMatch(nginx, /log_format[^;]*x-pdf-file-name/i);
  assert.doesNotMatch(nginx, /access_log[^;]*x-pdf-file-name/i);
  assert.match(launcher, /--hostname[\s\S]*127\.0\.0\.1/);
  assert.doesNotMatch(launcher, /\.\.\.process\.argv\.slice\(3\)/);
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
  assert.match(documentation, /ss -ltnp/);
  assert.match(documentation, /sqlite3/);
  assert.match(documentation, /schema|兼容/i);
  assert.match(documentation, /journalctl[^\n]*-n 100[^\n]*--no-pager/);
  assert.doesNotMatch(documentation, /^\s*(?:sudo\s+)?cat\s+\/etc\/pdf-checker\.env\s*$/m);
  assert.match(documentation, /sqlite3[^\n]*\.backup|systemctl stop[^\n]*pdf-checker/);
  assert.match(documentation, /not acceptable for a public or multi-user deployment|不适用于公开或多用户部署/i);
  assert.match(documentation, /dist\/audit-worker\.mjs/);
  assert.match(readme, /application\/pdf/);
  assert.match(readme, /X-Pdf-File-Name/);
  assert.match(readme, /SQLite/);
  assert.doesNotMatch(readme, /fileName` 查询参数/);
  assert.match(readme, /约\s*2\s*倍\s*20 MiB/);
  assert.match(readme, /vinext/i);
  assert.match(readme, /3\s*个.*并发上传|并发上传.*3\s*个/s);
  assert.doesNotMatch(readme, /当前应用在 multipart 输入流上/);
  for (const source of [readme, deploymentDesign, implementationPlan]) {
    let previous = -1;
    for (const command of [
      "sudo systemctl stop pdf-checker-worker.service",
      "sudo systemctl stop pdf-checker.service",
      'test -L "$current"',
      "mapfile -t rollback_dirs",
      'test "${#rollback_dirs[@]}" -eq 1',
      'sudo rm -f -- "$current"',
      'sudo mv -T -- "$backup" "$current"',
      "sudo systemctl restart pdf-checker.service",
      "sudo systemctl restart pdf-checker-worker.service",
      "curl -fsS http://127.0.0.1:3000/ >/dev/null",
    ]) {
      const index = source.indexOf(command, previous + 1);
      assert.ok(index > previous, `rollback documentation must contain ordered command: ${command}`);
      previous = index;
    }
    assert.doesNotMatch(source, /sudo mv\s+"\$backup"\s+"\$current"/);
  }
});

test("release activation uses an atomic same-parent symlink and protects a first directory migration", async () => {
  const source = await readFile(new URL("../deploy/activate-release.sh", import.meta.url), "utf8");

  assert.match(source, /^set -euo pipefail$/m);
  assert.match(source, /PDF_CHECKER_ROOT/);
  assert.match(source, /\$releases\/\$commit/);
  assert.match(source, /dist\/audit-worker\.mjs/);
  assert.match(source, /dist\/server\/index\.js/);
  assert.match(source, /dist\/server\/vinext-server\.json/);
  assert.match(source, /\.current\.next\./);
  assert.match(source, /\.current\.pre-symlink\./);
  assert.match(source, /mv -Tf/);
  assert.match(source, /readlink -f/);
  assert.match(source, /trap/);
});
