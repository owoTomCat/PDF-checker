# GitHub Main 与腾讯云部署设计

## 目标

- 以当前 `codex/strict-audit-rules` 的提交树覆盖 GitHub `main`，旧 `main` 不再作为默认代码。
- 在腾讯云 Ubuntu 24.04 服务器部署同一 `main` 提交。
- 通过 `http://[2402:4e00:1420:900:3c84:524:bcf4:0]/` 直接访问应用。
- API Key 只保存在服务器 `/etc/pdf-checker.env`，不进入 Git 历史。

## GitHub 发布

- 发布前记录远端旧 `main` 提交 `6e3d630f7ac36ff7d4308e41ce71eaea567dbdac`。
- 使用 `--force-with-lease` 把当前 HEAD 写入 `refs/heads/main`；若发布期间远端 `main` 被其他人更新则拒绝覆盖。
- GitHub 默认分支保持 `main`，不创建中间 PR。

## 服务器结构

- 代码目录：`/opt/pdf-checker/current`，从 GitHub `main` 克隆。
- Node：官方 Node.js 24 x64 发行包，安装到 `/opt`，通过 `/usr/local/bin` 提供命令。
- 依赖与构建：`npm ci` 后执行 `npm run build`。
- 常驻进程：`pdf-checker.service` 以 `ubuntu` 用户运行 `scripts/run-vinext.mjs start`，监听本机 3000 端口并随系统启动。
- 入口：Nginx 同时监听 IPv4/IPv6 80 端口，反向代理到 `127.0.0.1:3000`，请求体上限 25 MiB，模型调用超时 300 秒。
- 密钥：把本地忽略的 `.env.local` 安装为 root-only 的 `/etc/pdf-checker.env`。

## 验证与回滚

- 发布前运行完整测试、类型检查和 lint。
- 服务器验证 `npm run build`、`systemd-analyze verify`、`nginx -t`、服务状态和本机 HTTP 200。
- 客户端通过公网 IPv6 请求页面，并运行一个 PDF 案例确认模型链路。
- GitHub 回滚可将记录的旧提交重新推送到 `main`；服务器回滚可检出目标提交、重新构建并重启服务。
