"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runAuditFromPdf } from "@/lib/audit-runner";
import type { AuditTaskDetail, AuditTaskSummary, TaskStatus } from "@/lib/types";

const STORAGE_KEY = "pdf-audit-workspace.tasks.v2";

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

function readStoredTasks(): AuditTaskDetail[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AuditTaskDetail[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredTasks(tasks: AuditTaskDetail[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.slice(0, 80)));
}

function taskToSummary(task: AuditTaskDetail): AuditTaskSummary {
  return {
    id: task.id,
    fileName: task.fileName,
    fileSize: task.fileSize,
    fileType: task.fileType,
    status: task.status,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    errorMessage: task.errorMessage,
    issueCount: task.report?.issues.length ?? null,
    summary: task.summary,
  };
}

function saveTask(task: AuditTaskDetail) {
  const current = readStoredTasks();
  const next = [task, ...current.filter((item) => item.id !== task.id)].sort(
    (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
  );
  writeStoredTasks(next);
  return next;
}

function createQueuedTask(file: File): AuditTaskDetail {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || "application/pdf",
    status: "queued",
    progress: 5,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    issueCount: null,
    summary: null,
    reportText: null,
    report: null,
  };
}

export function AuditConsole() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileCacheRef = useRef(new Map<string, File>());
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

  const refreshFromStorage = useCallback((preferredId?: string | null) => {
    const stored = readStoredTasks();
    const summaries = stored.map(taskToSummary);
    const nextSelectedId = preferredId ?? summaries[0]?.id ?? null;
    setTasks(summaries);
    setSelectedId(nextSelectedId);
    setDetail(stored.find((task) => task.id === nextSelectedId) ?? null);
  }, []);

  const updateTask = useCallback((task: AuditTaskDetail) => {
    const stored = saveTask(task);
    setTasks(stored.map(taskToSummary));
    setSelectedId(task.id);
    setDetail(task);
  }, []);

  const processLocalTask = useCallback(
    async (task: AuditTaskDetail, file: File) => {
      const started: AuditTaskDetail = {
        ...task,
        status: "processing",
        progress: 35,
        startedAt: task.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        errorMessage: null,
      };
      updateTask(started);

      try {
        const { reportText, storedResult } = await runAuditFromPdf(
          await file.arrayBuffer(),
        );
        const completed: AuditTaskDetail = {
          ...started,
          status: "completed",
          progress: 100,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          errorMessage: null,
          reportText,
          report: storedResult.report as AuditTaskDetail["report"],
          summary: storedResult.summary,
        };
        updateTask(completed);
        setNotice("处理完成。结果已保存到当前浏览器的历史任务中。");
      } catch (error) {
        const failed: AuditTaskDetail = {
          ...started,
          status: "failed",
          progress: 100,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          errorMessage:
            error instanceof Error ? error.message : "PDF 处理失败。",
        };
        updateTask(failed);
        setNotice(failed.errorMessage);
      }
    },
    [updateTask],
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
      setNotice(`已接收 ${files.length} 个 PDF，正在当前浏览器中并行处理。`);

      try {
        const queuedTasks = files.map((file) => {
          const task = createQueuedTask(file);
          fileCacheRef.current.set(task.id, file);
          updateTask(task);
          return task;
        });
        setSelectedId(queuedTasks[0]?.id ?? null);
        setDetail(queuedTasks[0] ?? null);
        await Promise.all(
          queuedTasks.map((task) =>
            processLocalTask(task, fileCacheRef.current.get(task.id)!),
          ),
        );
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [processLocalTask, updateTask],
  );

  const runTask = useCallback(
    async (id: string) => {
      const task = readStoredTasks().find((item) => item.id === id);
      const file = fileCacheRef.current.get(id);
      if (!task || !file) {
        setNotice("历史结果可以直接回看；如需重新处理，请重新选择原 PDF 文件。");
        return;
      }
      setNotice("任务正在当前浏览器中处理。你可以继续上传其他 PDF。");
      await processLocalTask(task, file);
    },
    [processLocalTask],
  );

  useEffect(() => {
    refreshFromStorage();
  }, [refreshFromStorage]);

  useEffect(() => {
    if (!selectedId) return;
    const stored = readStoredTasks();
    setDetail(stored.find((task) => task.id === selectedId) ?? null);
  }, [selectedId, tasks]);

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
            上传 PDF 后系统会在当前浏览器中创建任务，提取报告中的首页字段、结果表格和出处截图线索，
            再复用现有规则输出核验结论。历史任务会保存在当前浏览器，便于回看。
          </p>
          <div className="hero-actions">
            <button type="button" onClick={() => inputRef.current?.click()}>
              上传 PDF
            </button>
            <span>支持一次选择多个文件，并行处理；PDF 不会上传到服务器。</span>
          </div>
        </div>
        <div className="hero-card" aria-label="任务概览">
          <div>
            <span>历史任务</span>
            <strong>{tasks.length}</strong>
          </div>
          <div>
            <span>处理中</span>
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
            文件会直接在浏览器内处理，结果保存到本机历史记录。不会再触发线上上传请求。
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "处理中" : "选择文件"}
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
            <button type="button" className="ghost" onClick={() => refreshFromStorage(selectedId)}>
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
