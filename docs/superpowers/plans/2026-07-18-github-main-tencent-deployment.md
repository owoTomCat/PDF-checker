# GitHub Main and Tencent Cloud Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace GitHub `main` with the current application and run that exact commit as a persistent IPv6-accessible Tencent Cloud service.

**Architecture:** Publish with a guarded force push, then clone `main` to `/opt/pdf-checker/current`. Run the vinext production server under systemd on port 3000 and expose it through Nginx on IPv6 port 80, with secrets isolated in `/etc/pdf-checker.env`.

**Tech Stack:** Git/GitHub CLI, Node.js 24, npm, vinext, systemd, Nginx, Ubuntu 24.04, SSH over IPv6

## Global Constraints

- Never commit `.env.local` or print `DASHSCOPE_API_KEY`.
- Guard the destructive main update with `--force-with-lease` against commit `6e3d630f7ac36ff7d4308e41ce71eaea567dbdac`.
- Deploy GitHub `main`, not an unpushed local tree.
- Run the application as `ubuntu`, while `/etc/pdf-checker.env` remains root-owned mode `0600`.
- Expose only Nginx port 80 publicly; keep application port 3000 behind the proxy.

---

### Task 1: Validate and publish GitHub main

**Files:**
- Verify: repository working tree and ignored `.env.local`

**Interfaces:**
- Consumes: current `codex/strict-audit-rules` HEAD and authenticated `gh`/Git remote.
- Produces: GitHub `main` pointing at the validated HEAD.

- [ ] Run `npm test`, `npm run typecheck`, and `npm run lint`; require zero failures.
- [ ] Confirm `git status --short` is empty and `.env.local` is ignored.
- [ ] Push with `git push origin HEAD:refs/heads/main --force-with-lease=refs/heads/main:6e3d630f7ac36ff7d4308e41ce71eaea567dbdac`.
- [ ] Verify `git ls-remote origin refs/heads/main` equals local HEAD and GitHub default branch is `main`.

### Task 2: Provision the server runtime

**Files:**
- Install: official Node.js 24 under `/opt`
- Install: Ubuntu `nginx`, `curl`, `ca-certificates`, and `xz-utils`

**Interfaces:**
- Consumes: passwordless sudo and outbound HTTPS.
- Produces: `node`, `npm`, Git and Nginx commands available on the server.

- [ ] Install required Ubuntu packages with `apt-get`.
- [ ] Download Node.js 24 from `nodejs.org`, verify it against the official `SHASUMS256.txt`, extract it under `/opt`, and create `/usr/local/bin` symlinks.
- [ ] Confirm Node meets `>=22.13.0` and Nginx is installed.

### Task 3: Deploy and configure services

**Files:**
- Copy: `deploy/pdf-checker.service` to `/etc/systemd/system/pdf-checker.service`
- Copy: `deploy/nginx-pdf-checker.conf` to `/etc/nginx/sites-available/pdf-checker`
- Install: local `.env.local` as `/etc/pdf-checker.env`

**Interfaces:**
- Consumes: published GitHub `main`, server runtime and local secret file.
- Produces: built application, enabled systemd service and Nginx reverse proxy.

- [ ] Clone GitHub `main` into `/opt/pdf-checker/current` and give `ubuntu` ownership.
- [ ] Run `npm ci` and `npm run build` as `ubuntu`.
- [ ] Transfer the environment and service templates, install with correct ownership/modes, and validate with `systemd-analyze verify` and `nginx -t`.
- [ ] Enable and restart `pdf-checker` and Nginx.

### Task 4: End-to-end verification

**Files:**
- No repository changes.

**Interfaces:**
- Consumes: running server and public IPv6 address.
- Produces: evidence that the deployed page and model pipeline work.

- [ ] Confirm `systemctl is-active pdf-checker nginx` and inspect bounded logs for errors.
- [ ] Confirm server-local `http://127.0.0.1:3000/` and Nginx `http://[::1]/` return HTTP 200.
- [ ] Confirm the client can reach `http://[2402:4e00:1420:900:3c84:524:bcf4:0]/` on port 80.
- [ ] Upload one real test PDF through the public page and confirm a completed report or a rule-level review result without transport/model-service errors.
