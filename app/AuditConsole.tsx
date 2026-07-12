"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuditTaskDetail, AuditTaskSummary, TaskStatus } from "@/lib/types";

const statusCopy: Record<TaskStatus, string> = {
  queued: "排队中",
  processing: "处理中",
  completed: "已完成",
  failed: "失败",
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function readError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || "请求失败。";
  } catch {
    return "请求失败。";
  }
}

export function AuditConsole() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [tasks, setTasks] = useState<AuditTaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditTaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [selectedId, tasks],
  );

  const loadTasks = useCallback(async () => {
    const response = await fetch("/api/tasks", { cache: "no-store" });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as { tasks: AuditTaskSummary[] };
    setTasks(payload.tasks);
    if (!selectedId && payload.tasks[0]) {
      setSelectedId(payload.tasks[0].id);
    }
  }, [selectedId]);

  const loadDetail = useCallback(async (id: string) => {
    const response = await fetch(`/api/tasks/${id}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as { task: AuditTaskDetail };
    setDetail(payload.task);
  }, []);

  const runTask = useCallback(
    async (id: string) => {
      setNotice("任务已进入后台处理。你可以继续上传其他 PDF。");
      const response = await fetch(`/api/tasks/${id}/run`, { method: "POST" });
      if (!response.ok) {
        setNotice(await readError(response));
      }
      await loadTasks();
      await loadDetail(id).catch(() => undefined);
    },
    [loadDetail, loadTasks],
  );

  const uploadFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter(
        (file) =>
          file.type === "application/pdf" ||
          file.name.toLowerCase().endsWith(".pdf"),
      );
      if (files.length === 0) {
        setNotice("请上传 PDF 文件。");
        return;
      }

      setBusy(true);
      setNotice(`已接收 ${files.length} 个 PDF，正在创建并行任务。`);
      try {
        await Promise.all(
          files.map(async (file) => {
            const form = new FormData();
            form.append("file", file);
            const response = await fetch("/api/tasks", {
              method: "POST",
              body: form,
            });
            if (!response.ok) throw new Error(await readError(response));
            const payload = (await response.json()) as {
              task: AuditTaskSummary;
            };
            setSelectedId(payload.task.id);
            void runTask(payload.task.id);
          }),
        );
        await loadTasks();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "上传失败。");
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [loadTasks, runTask],
  );

  useEffect(() => {
    loadTasks().catch((error) =>
      setNotice(error instanceof Error ? error.message : "读取任务失败。"),
    );
  }, [loadTasks]);

  useEffect(() => {
    if (!selectedId) return;
    loadDetail(selectedId).catch(() => undefined);
  }, [loadDetail, selectedId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (tasks.some((task) => task.status === "queued" || task.status === "processing")) {
        loadTasks().catch(() => undefined);
        if (selectedId) loadDetail(selectedId).catch(() => undefined);
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [loadDetail, loadTasks, selectedId, tasks]);

  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const activeCount = tasks.filter(
    (task) => task.status === "queued" || task.status === "processing",
  ).length;
  const issueCount = tasks.reduce((total, task) => total + (task.issueCount ?? 0), 0);

  return (
    <main className="audit-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">PDF Audit Workspace</p>
          <h1>外网溯源结果报告自动核验台</h1>
          <p className="hero-text">
            上传 PDF 后系统会创建后台任务，提取报告中的首页字段、结果表格和出处截图线索，
            再复用现有规则输出核验结论。历史任务会保留，便于回看和复跑。
          </p>
          <div className="hero-actions">
            <button type="button" onClick={() => inputRef.current?.click()}>
              上传 PDF
            </button>
            <span>支持一次选择多个文件，并行处理。</span>
          </div>
        </div>
        <div className="hero-card" aria-label="任务概览">
          <div>
            <span>历史任务</span>
            <strong>{tasks.length}</strong>
          </div>
          <div>
            <span>后台处理中</span>
            <strong>{activeCount}</strong>
          </div>
          <div>
            <span>累计问题</span>
            <strong>{issueCount}</strong>
          </div>
          <div>
            <span>已完成</span>
            <strong>{completedCount}</strong>
          </div>
        </div>
      </section>

      <section
        className={`upload-zone ${dragging ? "is-dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void uploadFiles(event.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          onChange={(event) => {
            if (event.currentTarget.files) {
              void uploadFiles(event.currentTarget.files);
            }
          }}
        />
        <div className="upload-icon">PDF</div>
        <div>
          <h2>拖入或选择外网溯源报告</h2>
          <p>
            文件会保存到任务记录中，处理完成后可在右侧查看结构化摘要、问题列表和完整中文报告。
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "创建任务中" : "选择文件"}
        </button>
      </section>

      {notice ? <p className="notice">{notice}</p> : null}

      <section className="workspace-grid">
        <aside className="task-panel" aria-label="历史任务">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">History</p>
              <h2>历史任务</h2>
            </div>
            <button type="button" className="ghost" onClick={() => void loadTasks()}>
              刷新
            </button>
          </div>

          <div className="task-list">
            {tasks.length === 0 ? (
              <div className="empty">还没有任务。上传 PDF 后会显示在这里。</div>
            ) : (
              tasks.map((task) => (
                <button
                  type="button"
                  key={task.id}
                  className={`task-row ${task.id === selectedId ? "selected" : ""}`}
                  onClick={() => setSelectedId(task.id)}
                >
                  <span className={`status-dot ${task.status}`} />
                  <span className="task-main">
                    <strong>{task.fileName}</strong>
                    <small>
                      {formatBytes(task.fileSize)} · {formatTime(task.createdAt)}
                    </small>
                  </span>
                  <span className="task-meta">
                    {statusCopy[task.status]}
                    {task.issueCount !== null ? ` · ${task.issueCount} 项` : ""}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="result-panel" aria-label="查验结果">
          {!selectedTask ? (
            <div className="empty large">选择一个历史任务查看结果。</div>
          ) : (
            <>
              <div className="result-header">
                <div>
                  <p className="eyebrow">Result</p>
                  <h2>{selectedTask.fileName}</h2>
                  <p>
                    状态：{statusCopy[selectedTask.status]} · 最近更新：
                    {formatTime(selectedTask.updatedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void runTask(selectedTask.id)}
                  disabled={selectedTask.status === "processing"}
                >
                  重新处理
                </button>
              </div>

              <div className="progress-track" aria-label="处理进度">
                <span style={{ width: `${selectedTask.progress}%` }} />
              </div>

              {detail?.summary ? (
                <div className="summary-grid">
                  <div>
                    <span>页数</span>
                    <strong>{detail.summary.pageCount ?? "—"}</strong>
                  </div>
                  <div>
                    <span>结果表格</span>
                    <strong>{detail.summary.groupCount}</strong>
                  </div>
                  <div>
                    <span>表格行</span>
                    <strong>{detail.summary.tableRowCount}</strong>
                  </div>
                  <div>
                    <span>问题数</span>
                    <strong>{detail.report?.issues.length ?? 0}</strong>
                  </div>
                </div>
              ) : null}

              {selectedTask.errorMessage ? (
                <div className="error-box">{selectedTask.errorMessage}</div>
              ) : null}

              {detail?.summary?.warnings.length ? (
                <div className="warning-box">
                  <h3>识别提示</h3>
                  <ul>
                    {detail.summary.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {detail?.report?.issues.length ? (
                <div className="issues">
                  <h3>问题列表</h3>
                  {detail.report.issues.map((issue, index) => (
                    <article key={`${issue.code}-${index}`}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{issue.code}</strong>
                        <p>{issue.message}</p>
                      </div>
                    </article>
                  ))}
                </div>
              ) : detail?.status === "completed" ? (
                <div className="success-box">经核查，当前 PDF 未发现规则错误。</div>
              ) : null}

              <div className="report-block">
                <h3>完整中文报告</h3>
                <pre>
                  {detail?.reportText ??
                    (selectedTask.status === "processing"
                      ? "任务处理中，请稍候..."
                      : "暂无报告。")}
                </pre>
              </div>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
