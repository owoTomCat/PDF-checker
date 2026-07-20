# PDF-checker

PDF-checker 使用阿里云百炼 `qwen3.7-plus` 对“PDF 外网溯源报告”执行严格的视觉识别、证据关联与确定性规则复核。

## 当前处理方式

浏览器只负责选择文件、上传、查看历史任务和轮询进度。每个原始 PDF 会先通过 `POST /api/tasks` 写入服务器私有目录，再创建 SQLite 排队任务；独立 worker 在服务器上解析和渲染 PDF、调用模型链路、把进度和最终结果写回 SQLite。关闭或刷新浏览器不会中断任务。

- 原始 PDF 仅存放在服务器 `/var/lib/pdf-checker/uploads`，默认上传后保留 72 小时；任务排队或处理中不会被清理。
- 结果和任务历史保存在 `/var/lib/pdf-checker/data/pdf-checker.sqlite`；渲染页、裁剪图、原始模型响应和 API Key 不会持久化或返回给浏览器。
- 单台服务器最多同时处理 3 个任务；额外上传会排队。
- worker 重启会从头重新排队未完成任务；连续三次崩溃恢复仍无法完成的任务会失败，避免无限重试。
- 当前部署是明确的单租户共享历史模式：受信用户在不同电脑上可看见相同的历史任务和删除权限。

模型请求固定使用 `qwen3.7-plus`、JSON 模式和 `enable_thinking: false`，不设置 `max_tokens`。模型输出必须经过既有 Zod schema 校验，证据不足或定位不完整时会进入 `needs_review`，不会显示为通过。

严格证据边界仍然保留在服务器端：布局阶段只定位证书、网页截图、地址栏和汇总表；截图裁剪看不到汇总表，证书裁剪也不会混入表格内容。每条网页截图的地址栏从 PDF 生成 600 DPI 彩色图和灰度/对比度增强图成对复核；字符不确定时只标记人工复核，不自动替换。

## 本地开发

要求：Node.js `>=22.13.0`（生产使用 Node 24）、npm，以及可调用百炼兼容接口的服务器端环境变量。

复制 `.env.example` 为 `.env.local`，填写本地开发环境的百炼配置。不要使用 `NEXT_PUBLIC_` 前缀，也不要把真实 API Key 提交、贴入文档或打印到日志。

```bash
npm install
npm run dev
```

默认地址为 `http://localhost:3000`。完整校验命令：

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

`npm run build` 必须同时构建 web 和 worker；成功后应存在 `dist/audit-worker.mjs`。Linux 服务器需满足项目声明的 Node 版本，并确保 `@napi-rs/canvas` 的 Linux 原生依赖在 `npm ci` 后可加载。

在线备份和队列计数检查依赖 SQLite CLI；发布前应确认 `command -v sqlite3` 成功。Ubuntu 缺少该命令时先由管理员安装 `sqlite3` 软件包。

## 腾讯云单机部署

代码目录固定为 `/opt/pdf-checker/current`，私有任务数据固定为 `/var/lib/pdf-checker`。代码发布和版本切换不得触碰私有数据目录。

先在已检出的发布版本目录执行安装和构建：

```bash
cd /opt/pdf-checker/current
npm ci
npm run build
test -f dist/audit-worker.mjs

sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/pdf-checker
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/pdf-checker/data
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/pdf-checker/uploads
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/pdf-checker/data/backups
sudo install -o root -g root -m 0644 deploy/pdf-checker.service /etc/systemd/system/pdf-checker.service
sudo install -o root -g root -m 0644 deploy/pdf-checker-worker.service /etc/systemd/system/pdf-checker-worker.service
sudo systemctl daemon-reload
```

使用 `sudoedit /etc/pdf-checker.env` 创建或更新 root 拥有、模式 `0600` 的环境文件。保留已有的百炼连接配置；不要用 `cat /etc/pdf-checker.env` 显示它的内容。增加以下五项：

```dotenv
PDF_AUDIT_DATA_DIR=/var/lib/pdf-checker
PDF_AUDIT_PDF_RETENTION_HOURS=72
PDF_AUDIT_WORKER_CONCURRENCY=3
PDF_AUDIT_WORKER_POLL_MS=1000
PDF_AUDIT_SINGLE_TENANT_OWNER=shared-server
```

当前腾讯云单租户部署还必须设置 `PDF_AUDIT_REQUIRE_AUTH=false`。此模式会忽略请求携带的身份头，并让每一个能访问站点的网络客户端共享同一份历史和删除权限。因此腾讯云防火墙或反向代理必须只允许受信用户访问；它不适用于公开或多用户部署。

将来接入可信认证代理时，应改为 `PDF_AUDIT_REQUIRE_AUTH=true`，由代理提供 `oai-authenticated-user-email`，并把 `PDF_AUDIT_SINGLE_TENANT_OWNER` 留空。不要在未接入可信认证代理时启用这个多用户模式。

确认环境文件权限后启动两个独立服务：

```bash
sudo chown root:root /etc/pdf-checker.env
sudo chmod 0600 /etc/pdf-checker.env
sudo systemctl enable --now pdf-checker.service pdf-checker-worker.service
```

web 服务可以在 worker 故障时继续提供上传、历史和状态查询；worker 服务恢复后会继续领取队列任务。

web systemd unit 以 `--hostname 127.0.0.1` 启动，因此应用端口只绑定 loopback，由 Nginx 对外提供访问。验收时必须确认没有将 Node 3000 端口暴露到公网：

```bash
sudo ss -ltnp | grep ':3000'
```

输出应只显示 `127.0.0.1:3000`（如启用 IPv6 loopback，也只能是 `::1:3000`）。

Nginx 使用 `deploy/nginx-pdf-checker.conf`，并保留 `client_max_body_size 25m`，以接受最大 20 MiB 的 PDF 加 multipart 开销。安装或更新 Nginx 配置后执行 `sudo nginx -t`，再重载 Nginx。

当前 Nginx 会显式清空入站 `oai-authenticated-user-email`，所以当前配置不支持认证模式；不能只把 `PDF_AUDIT_REQUIRE_AUTH` 改为 `true`。未来可信认证代理必须先完成认证，拒绝或清除客户端伪造的该头，再以代理控制的不可伪造变量覆盖它，同时保持 3000 端口仅 loopback 可见。

## 运行检查与安全运维

在服务器上执行下列检查；这些命令不会输出 API Key、PDF 内容、完整报告或绝对任务文件路径：

```bash
sudo systemd-analyze verify /etc/systemd/system/pdf-checker.service /etc/systemd/system/pdf-checker-worker.service
sudo systemctl is-active pdf-checker.service pdf-checker-worker.service nginx.service
sudo journalctl -u pdf-checker.service -n 100 --no-pager
sudo journalctl -u pdf-checker-worker.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3000/ > /dev/null
sudo -u ubuntu sqlite3 /var/lib/pdf-checker/data/pdf-checker.sqlite "SELECT status, COUNT(*) AS task_count FROM audit_tasks GROUP BY status;"
sudo stat -c '%a %U:%G %n' /var/lib/pdf-checker /var/lib/pdf-checker/data /var/lib/pdf-checker/uploads
sudo du -sh /var/lib/pdf-checker
```

队列状态查询只输出每种状态的任务数量。不要用日志、数据库查询或浏览器响应记录/输出原始 PDF、页面图、模型原始响应、认证头或环境文件内容。

数据库在运行时使用 WAL，禁止对活跃数据库直接执行 `cp`。推荐使用 SQLite 在线备份，并把备份与数据目录同样视为私有数据：

```bash
sudo -u ubuntu sqlite3 /var/lib/pdf-checker/data/pdf-checker.sqlite ".backup '/var/lib/pdf-checker/data/backups/pdf-checker-$(date +%F-%H%M%S).sqlite'"
```

也可在明确的维护窗口先停止两个服务，再复制数据库及其所需数据目录；恢复前先验证备份可由 SQLite 打开。PDF 保留期验证应在上传后超过 72 小时检查：任务结果仍在，终态任务的 `pdf_deleted_at` 已标记且上传文件数减少；不得通过删除排队或活动任务来“验证”清理。

收到 systemd 停止信号时，worker 会停止领取新任务，将已经协作式中止的 active claim 重新入队并撤销这一次 claim 计数；正常情况远小于 `TimeoutStopSec=120`。PDF 原生渲染并非所有阶段都能立刻抢占，因此 120 秒只是在协作清理失效时才由 systemd 发送 SIGKILL 的上限。Ubuntu 验收必须在一个实际长任务期间执行停止操作，并确认任务重新排队且没有消耗三次恢复额度。

发布或回滚时，先停止 worker、再停止 web，切换代码并运行 `npm ci && npm run build`，确认 `dist/audit-worker.mjs` 后先启动 web、再启动 worker：

```bash
sudo systemctl stop pdf-checker-worker.service
sudo systemctl stop pdf-checker.service
# 检出目标版本、npm ci、npm run build，并重新安装两个 unit 文件后：
sudo systemctl daemon-reload
sudo systemctl restart pdf-checker.service
sudo systemctl restart pdf-checker-worker.service
```

回滚不会删除 `/var/lib/pdf-checker`，因此既有任务、结果和仍在 72 小时保留期内的 PDF 会保留。更新后再次执行上述服务状态、bounded journal、HTTP、队列计数、权限和容量检查。

回滚前先检查目标代码的 SQLite schema 和 worker 任务状态与当前数据是否兼容。若不兼容，保持两个服务停止，从已验证的 SQLite 备份及其必要私有数据恢复后再启动；不要把新版本数据库直接交给旧 worker。

## 主要文件

- `app/AuditConsole.tsx` 与 `app/useAuditTasks.ts`：浏览器端上传、轮询和历史任务界面。
- `app/api/tasks/`：上传、列表、详情、重试、删除、批量删除和历史导入 API。
- `lib/server/task-repository.ts`：SQLite 任务状态、所有者范围和队列声明。
- `lib/server/task-worker.ts`：三槽 durable worker、恢复、清理和错误持久化。
- `lib/server/pdf-renderer.ts`：服务端 PDF.js 与 canvas 渲染。
- `deploy/pdf-checker.service`：web/API systemd 服务。
- `deploy/pdf-checker-worker.service`：独立 worker systemd 服务。

## 官方资料

- [百炼 OpenAI Chat Completions](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)
- [百炼结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)
- [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
- [Node SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
