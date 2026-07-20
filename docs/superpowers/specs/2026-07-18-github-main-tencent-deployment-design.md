# GitHub main 与腾讯云部署设计

## 目标与边界

GitHub `main` 对应腾讯云 Ubuntu 24.04 上的同一发布提交。应用代码位于 `/opt/pdf-checker/current`，私有 PDF、SQLite 数据库和备份位于 `/var/lib/pdf-checker`。发布、回滚或代码目录切换绝不能清除该数据目录。

部署运行两个相互独立的 systemd 服务：

1. `pdf-checker.service` 提供 web 页面和任务 API，监听本机 `127.0.0.1:3000`。
2. `pdf-checker-worker.service` 运行已构建的 `dist/audit-worker.mjs`，从同一个 SQLite 队列领取任务。

Nginx 监听 IPv4/IPv6 80 端口并代理到 web 服务，`client_max_body_size 25m` 保持不变。上传接口只在私有文件和 SQLite 排队记录都成功写入后返回；模型处理由独立 worker 完成，所以浏览器断开不会中断任务。

## 发布前提

- 使用 Node 24（满足项目声明的 `>=22.13.0`）与 npm。
- 运行 `npm ci && npm run build`；发布产物必须同时包含 web 构建和 `dist/audit-worker.mjs`。
- 在 Linux 上确认 `@napi-rs/canvas` 的原生依赖可由生产 Node 加载。
- 确认 `command -v sqlite3` 可用；在线数据库备份和安全的队列计数检查依赖该 CLI。Ubuntu 缺少时先由管理员安装 `sqlite3` 软件包。
- 百炼连接配置只保存在服务器 `/etc/pdf-checker.env`；不写入 Git、systemd unit、文档、日志或接口响应。

## 私有数据目录和 systemd 安装

在 `/opt/pdf-checker/current` 的目标发布版本中构建后，使用精确命令安装目录和 unit：

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

两个服务均以 `ubuntu:ubuntu` 运行，使用 `UMask=0077`，并只被允许写入 `/var/lib/pdf-checker`。两者都必须通过非可选的 `EnvironmentFile=/etc/pdf-checker.env` 启动；环境文件缺失应让服务失败，而不是以不完整配置运行。

## 生产环境变量和访问控制

用 `sudoedit /etc/pdf-checker.env` 更新服务器密钥文件，然后确认它是 `root:root`、模式 `0600`。禁止用 `cat /etc/pdf-checker.env` 读取或把它发送到日志、工单或聊天记录。

保留已有的百炼连接变量，并添加：

```dotenv
PDF_AUDIT_DATA_DIR=/var/lib/pdf-checker
PDF_AUDIT_PDF_RETENTION_HOURS=72
PDF_AUDIT_WORKER_CONCURRENCY=3
PDF_AUDIT_WORKER_POLL_MS=1000
PDF_AUDIT_SINGLE_TENANT_OWNER=shared-server
```

当前腾讯云服务使用单租户共享历史模式，必须设置 `PDF_AUDIT_REQUIRE_AUTH=false`。在此模式中所有网络客户端共享相同任务历史和删除权限；腾讯云安全组/防火墙或前置反向代理必须只允许受信用户访问。这不是公开或多用户部署的可接受配置。

当可信认证代理可提供 `oai-authenticated-user-email` 时，改为 `PDF_AUDIT_REQUIRE_AUTH=true`，并将 `PDF_AUDIT_SINGLE_TENANT_OWNER` 留空。服务端只信任该代理提供的认证头，不接受浏览器伪造的身份。

```bash
sudo chown root:root /etc/pdf-checker.env
sudo chmod 0600 /etc/pdf-checker.env
sudo systemctl enable --now pdf-checker.service pdf-checker-worker.service
```

web 不依赖 worker 成功启动；worker 暂时不可用时，web 仍可接收上传、显示任务历史和状态，worker 恢复后继续领取队列。

web unit 使用受控的 `--hostname 127.0.0.1` 参数，因此 3000 只应由 Nginx 访问。部署验收必须确认监听地址没有暴露到公网：

```bash
sudo ss -ltnp | grep ':3000'
```

输出只允许 `127.0.0.1:3000`（若启用 IPv6 loopback，则仅 `::1:3000`）。

当前 Nginx 显式清空请求中的 `oai-authenticated-user-email`，因此当前配置不支持认证模式，不能只把 `PDF_AUDIT_REQUIRE_AUTH` 切为 `true`。未来可信认证代理必须先认证、拒绝或清除客户端传入的伪造头，再使用代理控制的不可伪造变量覆盖该头，并继续封闭 3000 端口到 loopback。

## 状态、日志与健康检查

先验证 unit 和 Nginx，再分别检查服务。日志必须有上限，不能打印环境文件、PDF 内容、渲染图、原始模型响应、认证头或完整报告。

```bash
sudo systemd-analyze verify /etc/systemd/system/pdf-checker.service /etc/systemd/system/pdf-checker-worker.service
sudo nginx -t
sudo systemctl is-active pdf-checker.service pdf-checker-worker.service nginx.service
sudo journalctl -u pdf-checker.service -n 100 --no-pager
sudo journalctl -u pdf-checker-worker.service -n 100 --no-pager
curl -fsS http://127.0.0.1:3000/ > /dev/null
sudo -u ubuntu sqlite3 /var/lib/pdf-checker/data/pdf-checker.sqlite "SELECT status, COUNT(*) AS task_count FROM audit_tasks GROUP BY status;"
sudo stat -c '%a %U:%G %n' /var/lib/pdf-checker /var/lib/pdf-checker/data /var/lib/pdf-checker/uploads
sudo du -sh /var/lib/pdf-checker
```

队列 SQL 仅输出状态和计数，不输出 PDF 文件名、路径、报告或密钥。HTTP 检查证明 web 服务可响应；它不替代一次真实 PDF 的完整验收。

## 数据保留、备份和恢复

worker 会在启动及周期性清理中删除超过 72 小时的终态 PDF，不会删除 queued 或 active PDF。验证清理时检查 `pdf_deleted_at` 和文件计数变化，同时确认任务结果仍可查询；不要通过人工删除活动任务来测试。

停止时 worker 不再领取任务，并把协作式中止的 active claim 重新入队且撤销本次 claim 计数；正常应远小于 `TimeoutStopSec=120`。PDF 原生渲染不能保证立刻可中断，120 秒是协作清理超时后 systemd 才发送 SIGKILL 的最后上限。Ubuntu 验收需要在实际长任务中停止 worker，并确认任务 queued 且没有耗尽恢复额度。

SQLite 运行时采用 WAL，禁止对活跃数据库进行裸 `cp`。推荐在线 SQLite 备份：

```bash
sudo -u ubuntu sqlite3 /var/lib/pdf-checker/data/pdf-checker.sqlite ".backup '/var/lib/pdf-checker/data/backups/pdf-checker-$(date +%F-%H%M%S).sqlite'"
```

维护窗口也可先停止两个服务，再连同数据目录中必要文件进行备份与恢复；恢复前用 SQLite 打开备份验证。备份包含私有任务结果和可能仍在保留期内的 PDF，必须继续限制为 `ubuntu` 可读的私有目录。

## 更新与回滚顺序

先让 worker 停止领取新任务，再停 web；更新或检出目标 Git 提交，执行依赖安装和完整构建，重新安装两个 unit，然后启动 web 和 worker：

```bash
sudo systemctl stop pdf-checker-worker.service
sudo systemctl stop pdf-checker.service
cd /opt/pdf-checker/current
# 切换到目标提交后：
npm ci
npm run build
test -f dist/audit-worker.mjs
sudo install -o root -g root -m 0644 deploy/pdf-checker.service /etc/systemd/system/pdf-checker.service
sudo install -o root -g root -m 0644 deploy/pdf-checker-worker.service /etc/systemd/system/pdf-checker-worker.service
sudo systemctl daemon-reload
sudo systemctl restart pdf-checker.service
sudo systemctl restart pdf-checker-worker.service
```

此顺序允许 web 先独立恢复，而 worker 随后处理积压任务。回滚只切换代码和重启服务，不覆盖 `/var/lib/pdf-checker`；完成后重跑 unit、服务、bounded journal、HTTP、队列计数、权限和容量检查。

回滚前必须检查目标提交的 SQLite schema 和 worker 任务状态是否与当前 `/var/lib/pdf-checker` 兼容。若不兼容，停止两个服务并从已经验证的 SQLite 备份及必要私有数据恢复，不能把较新的数据库直接交给较旧 worker。
