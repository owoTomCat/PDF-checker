import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const BASH = process.env.PDF_CHECKER_BASH ?? (
  process.platform === "win32" ? "C:/User_APP/git/Git/bin/bash.exe" : "bash"
);
const activationScript = path.resolve("deploy/activate-release.sh");
const commit = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const previousCommit = "b1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function posixPath(value) {
  if (process.platform !== "win32") return value;
  const result = await run(BASH, ["--noprofile", "--norc", "-c", "cygpath -u -- \"$1\"", "--", value]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function bashRealpath(value) {
  const posixValue = await posixPath(value);
  const result = await run(BASH, ["--noprofile", "--norc", "-c", "readlink -f -- \"$1\"", "--", posixValue]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function isBashSymlink(value) {
  const posixValue = await posixPath(value);
  const result = await run(BASH, ["--noprofile", "--norc", "-c", "test -L \"$1\"", "--", posixValue]);
  return result.status === 0;
}

async function createBashSymlink(target, link) {
  const [posixTarget, posixLink] = await Promise.all([posixPath(target), posixPath(link)]);
  const result = await run(BASH, ["--noprofile", "--norc", "-c", "ln -s -- \"$1\" \"$2\"", "--", posixTarget, posixLink], {
    env: {
      ...process.env,
      ...(process.platform === "win32" ? { MSYS: "winsymlinks:native" } : {}),
    },
  });
  assert.equal(result.status, 0, result.stderr);
}

async function makeRelease(root, id) {
  const release = path.join(root, "releases", id);
  await writeFile(path.join(release, "package.json"), "{}", { encoding: "utf8", flag: "wx" });
  await writeFile(path.join(release, "dist", "audit-worker.mjs"), "export {};", { encoding: "utf8", flag: "wx" });
  return release;
}

async function createActivationRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pdf-checker-activate-"));
  await mkdir(path.join(root, "releases", commit, "dist"), { recursive: true });
  await mkdir(path.join(root, "releases", previousCommit, "dist"), { recursive: true });
  await makeRelease(root, commit);
  await makeRelease(root, previousCommit);
  return root;
}

async function createMvFailureHook(root, stateFile, failAt) {
  const hook = path.join(root, `mv-fail-${failAt}.sh`);
  await writeFile(hook, `mv() {\n  local count=0\n  [[ -f \"$MV_COUNT_FILE\" ]] && count=$(<\"$MV_COUNT_FILE\")\n  count=$((count + 1))\n  printf '%s' \"$count\" > \"$MV_COUNT_FILE\"\n  if [[ \"$count\" -eq \"${failAt}\" ]]; then return 73; fi\n  command /usr/bin/mv \"$@\"\n}\n`);
  await chmod(hook, 0o755);
  return posixPath(hook);
}

async function activate(root, extraEnvironment = {}) {
  const [posixRoot, posixScript] = await Promise.all([posixPath(root), posixPath(activationScript)]);
  return run(BASH, ["--noprofile", "--norc", posixScript, commit], {
    env: {
      ...process.env,
      ...(process.platform === "win32" ? { MSYS: "winsymlinks:native" } : {}),
      PDF_CHECKER_ROOT: posixRoot,
      ...extraEnvironment,
    },
  });
}

test("activation migrates an ordinary current directory to the requested release symlink", async (t) => {
  const root = await createActivationRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, "current");
  await mkdir(current);
  await writeFile(path.join(current, "legacy-marker"), "keep for rollback");

  const result = await activate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await isBashSymlink(current), true);
  assert.equal(await bashRealpath(current), await bashRealpath(path.join(root, "releases", commit)));
  const names = await readdir(root);
  const backup = names.find((name) => name.startsWith(".current.pre-symlink."));
  assert.ok(backup);
  assert.equal(await readFile(path.join(root, backup, "legacy-marker"), "utf8"), "keep for rollback");
  assert.equal(names.some((name) => name.startsWith(".current.next.")), false);
});

test("activation atomically replaces an existing current symlink without creating a directory backup", async (t) => {
  const root = await createActivationRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, "current");
  await createBashSymlink(path.join(root, "releases", previousCommit), current);

  const result = await activate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await isBashSymlink(current), true);
  assert.equal(await bashRealpath(current), await bashRealpath(path.join(root, "releases", commit)));
  const names = await readdir(root);
  assert.equal(names.some((name) => name.startsWith(".current.pre-symlink.")), false);
});

test("activation cleans up its temporary link when preserving the old directory fails", async (t) => {
  const root = await createActivationRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, "current");
  await mkdir(current);
  await writeFile(path.join(current, "legacy-marker"), "do not move");
  const stateFile = path.join(root, "mv-count");

  const result = await activate(root, {
    BASH_ENV: await createMvFailureHook(root, stateFile, 1),
    MV_COUNT_FILE: await posixPath(stateFile),
  });
  assert.notEqual(result.status, 0);
  assert.equal((await lstat(current)).isDirectory(), true);
  assert.equal(await readFile(path.join(current, "legacy-marker"), "utf8"), "do not move");
  const names = await readdir(root);
  assert.equal(names.some((name) => name.startsWith(".current.next.")), false);
  assert.equal(names.some((name) => name.startsWith(".current.pre-symlink.")), false);
});

test("activation restores a first-migration directory when the second rename fails", async (t) => {
  const root = await createActivationRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = path.join(root, "current");
  await mkdir(current);
  await writeFile(path.join(current, "legacy-marker"), "restore me");
  const stateFile = path.join(root, "mv-count");

  const result = await activate(root, {
    BASH_ENV: await createMvFailureHook(root, stateFile, 2),
    MV_COUNT_FILE: await posixPath(stateFile),
  });
  const mvCount = await readFile(stateFile, "utf8").catch(() => "<missing>");
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}\nmv count: ${mvCount}`);
  assert.equal((await lstat(current)).isDirectory(), true);
  assert.equal(await readFile(path.join(current, "legacy-marker"), "utf8"), "restore me");
  const names = await readdir(root);
  assert.equal(names.some((name) => name.startsWith(".current.next.")), false);
  assert.equal(names.some((name) => name.startsWith(".current.pre-symlink.")), false);
});
