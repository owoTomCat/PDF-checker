"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  runAiAuditPipeline,
  type PipelineProgress,
} from "@/lib/client/audit-pipeline";
import { runWithConcurrency } from "@/lib/client/concurrency";
import { createTaskId } from "@/lib/client/task-id";
import {
  filterHistoryTasks,
  removeHistoryTasks,
  upsertHistoryTask,
  type HistoryDateFilter,
} from "@/lib/client/task-history";
import type {
  AuditOutcome,
  AuditTaskDetail,
  TaskStatus,
} from "@/lib/types";

const STORAGE_KEY = "pdf-audit-workspace.tasks.v4";
const MAX_PARALLEL_TASKS = 3;
const ACTIVE_STATUSES = new Set<TaskStatus>([
  "queued",
  "rendering",
  "locating",
  "recognizing",
  "reviewing_urls",
  "extracting_table",
  "associating",
  "finalizing",
]);

const statusCopy: Record<TaskStatus, string> = {
  queued: "排队中",
  rendering: "渲染页面",
  locating: "定位证据区域",
  recognizing: "识别证书和截图",
  reviewing_urls: "复核地址栏 URL",
  extracting_table: "提取汇总表",
  associating: "关联截图与表格",
  finalizing: "执行确定性规则",
  completed: "已完成",
  failed: "失败",
};

const outcomeCopy: Record<AuditOutcome, string> = {
  passed: "核验通过",
  issues_found: "发现问题",
  needs_review: "需人工复核",
  failed: "处理失败",
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

function normalizeStoredTask(value: unknown): AuditTaskDetail | null {
  if (!value || typeof value !== "object") return null;
  const task = value as Partial<AuditTaskDetail>;
  if (
    typeof task.id !== "string" ||
    typeof task.fileName !== "string" ||
    typeof task.fileSize !== "number" ||
    typeof task.createdAt !== "string"
  ) {
    return null;
  }
  const now = new Date().toISOString();
  const status =
    task.status && statusCopy[task.status]
      ? task.status
      : ("failed" as const);
  return {
    id: task.id,
    fileName: task.fileName.slice(0, 255),
    fileSize: task.fileSize,
    fileType: typeof task.fileType === "string" ? task.fileType : null,
    status,
    outcome: task.outcome ?? (status === "failed" ? "failed" : null),
    model: task.model === "qwen3.7-plus" ? task.model : null,
    progress: typeof task.progress === "number" ? task.progress : 0,
    processedPages:
      typeof task.processedPages === "number" ? task.processedPages : 0,
    totalPages: typeof task.totalPages === "number" ? task.totalPages : null,
    createdAt: task.createdAt,
    updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : now,
    startedAt: typeof task.startedAt === "string" ? task.startedAt : null,
    completedAt:
      typeof task.completedAt === "string" ? task.completedAt : null,
    errorMessage:
      typeof task.errorMessage === "string"
        ? task.errorMessage.slice(0, 1_000)
        : null,
    issueCount: typeof task.issueCount === "number" ? task.issueCount : null,
    summary: task.summary ?? null,
    reportText:
      typeof task.reportText === "string"
        ? task.reportText.slice(0, 1_000_000)
        : null,
    report: task.report ?? null,
  };
}

function readStoredTasks(): AuditTaskDetail[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeStoredTask)
      .filter((task): task is AuditTaskDetail => task !== null)
      .slice(0, 80);
  } catch {
    return [];
  }
}

function writeStoredTasks(tasks: AuditTaskDetail[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.slice(0, 80)));
}

function createQueuedTask(file: File): AuditTaskDetail {
  const now = new Date().toISOString();
  return {
    id: createTaskId(),
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || "application/pdf",
    status: "queued",
    outcome: null,
    model: "qwen3.7-plus",
    progress: 2,
    processedPages: 0,
    totalPages: null,
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

function statusFromProgress(progress: PipelineProgress): TaskStatus {
  return progress.stage;
}

function outcomeNotice(outcome: AuditOutcome, issueCount: number) {
  if (outcome === "passed") return "AI 核验完成，未发现规则问题。";
  if (outcome === "issues_found") {
    return `AI 核验完成，发现 ${issueCount} 项问题。`;
  }
  if (outcome === "needs_review") {
    return "AI 已完成识别，但证据不完整，结果需要人工复核。";
  }
  return "PDF 处理失败。";
}

export function AuditConsole() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileCacheRef = useRef(new Map<string, File>());
  const [tasks, setTasks] = useState<AuditTaskDetail[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyDateFilter, setHistoryDateFilter] =
    useState<HistoryDateFilter>("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [checkedTaskIds, setCheckedTaskIds] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      setTasks(readStoredTasks());
      setHistoryReady(true);
    }, 0);
    return () => window.clearTimeout(loadTimer);
  }, []);

  useEffect(() => {
    if (!historyReady) return;
    let errorTimer: number | null = null;
    try {
      writeStoredTasks(tasks);
    } catch {
      errorTimer = window.setTimeout(
        () => setNotice("历史记录未能保存到浏览器。"),
        0,
      );
    }
    return () => {
      if (errorTimer !== null) window.clearTimeout(errorTimer);
    };
  }, [historyReady, tasks]);

  const filteredTasks = useMemo(
    () =>
      filterHistoryTasks(tasks, {
        query: historyQuery,
        dateFilter: historyDateFilter,
        customStart,
        customEnd,
      }),
    [customEnd, customStart, historyDateFilter, historyQuery, tasks],
  );

  const selectedTask = useMemo(
    () =>
      filteredTasks.find((task) => task.id === selectedId) ??
      filteredTasks[0] ??
      null,
    [filteredTasks, selectedId],
  );

  const selectableFilteredIds = useMemo(
    () =>
      filteredTasks
        .filter((task) => !ACTIVE_STATUSES.has(task.status))
        .map((task) => task.id),
    [filteredTasks],
  );

  const checkedDeletableIds = useMemo(
    () =>
      [...checkedTaskIds].filter((id) => {
        const task = tasks.find((item) => item.id === id);
        return task && !ACTIVE_STATUSES.has(task.status);
      }),
    [checkedTaskIds, tasks],
  );

  const allFilteredChecked =
    selectableFilteredIds.length > 0 &&
    selectableFilteredIds.every((id) => checkedTaskIds.has(id));

  const updateTask = useCallback((task: AuditTaskDetail) => {
    setTasks((current) => upsertHistoryTask(current, task));
  }, []);

  const processTask = useCallback(
    async (task: AuditTaskDetail, file: File) => {
      let current: AuditTaskDetail = {
        ...task,
        status: "rendering",
        progress: 5,
        startedAt: task.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
        errorMessage: null,
        outcome: null,
      };
      updateTask(current);

      try {
        const result = await runAiAuditPipeline(file, {
          onProgress(progress) {
            current = {
              ...current,
              status: statusFromProgress(progress),
              progress: progress.progress,
              processedPages: progress.processedPages,
              totalPages: progress.totalPages,
              updatedAt: new Date().toISOString(),
            };
            updateTask(current);
          },
        });
        const completed: AuditTaskDetail = {
          ...current,
          status: "completed",
          outcome: result.outcome,
          model: result.model,
          progress: 100,
          processedPages: result.summary.pageCount,
          totalPages: result.summary.pageCount,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          errorMessage: null,
          issueCount: result.report.issues.length,
          summary: result.summary,
          reportText: result.reportText,
          report: result.report,
        };
        updateTask(completed);
        setNotice(
          outcomeNotice(result.outcome, result.report.issues.length),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "PDF 处理失败。";
        const failed: AuditTaskDetail = {
          ...current,
          status: "failed",
          outcome: "failed",
          progress: 100,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          errorMessage: message,
        };
        updateTask(failed);
        setNotice(message);
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
      setNotice(
        `已接收 ${files.length} 个 PDF，最多同时处理 ${MAX_PARALLEL_TASKS} 个。`,
      );
      try {
        const queuedTasks = files.map((file) => {
          const task = createQueuedTask(file);
          fileCacheRef.current.set(task.id, file);
          updateTask(task);
          return task;
        });
        setSelectedId(queuedTasks[0]?.id ?? null);
        await runWithConcurrency(
          queuedTasks,
          MAX_PARALLEL_TASKS,
          async (task) => {
            const file = fileCacheRef.current.get(task.id);
            if (file) await processTask(task, file);
          },
        );
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [processTask, updateTask],
  );

  const runTask = useCallback(
    async (id: string) => {
      const task = tasks.find((item) => item.id === id);
      const file = fileCacheRef.current.get(id);
      if (!task || !file) {
        setNotice("历史结果可以直接回看；重新处理需要再次选择原 PDF 文件。");
        return;
      }
      await processTask(task, file);
    },
    [processTask, tasks],
  );

  const toggleAllFilteredTasks = useCallback(() => {
    setCheckedTaskIds((current) => {
      const next = new Set(current);
      if (allFilteredChecked) {
        selectableFilteredIds.forEach((id) => next.delete(id));
      } else {
        selectableFilteredIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }, [allFilteredChecked, selectableFilteredIds]);

  const deleteTaskIds = useCallback(
    (requestedIds: ReadonlySet<string>, confirmation: string) => {
      const deletableIds = new Set(
        tasks
          .filter(
            (task) =>
              requestedIds.has(task.id) &&
              !ACTIVE_STATUSES.has(task.status),
          )
          .map((task) => task.id),
      );
      if (deletableIds.size === 0) {
        setNotice("处理中任务不能删除。");
        return;
      }
      if (!window.confirm(confirmation)) return;

      deletableIds.forEach((id) => fileCacheRef.current.delete(id));
      setTasks((current) => removeHistoryTasks(current, deletableIds));
      setCheckedTaskIds((current) => {
        const next = new Set(current);
        deletableIds.forEach((id) => next.delete(id));
        return next;
      });
      setSelectedId((current) =>
        current && deletableIds.has(current) ? null : current,
      );
      setNotice(`已删除 ${deletableIds.size} 条历史任务。`);
    },
    [tasks],
  );

  const activeCount = tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length;
  const reviewCount = tasks.filter(
    (task) => task.outcome === "needs_review",
  ).length;
  const issueCount = tasks.reduce(
    (total, task) => total + (task.issueCount ?? 0),
    0,
  );

  return (
    <main className="audit-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Qwen AI Audit Workspace</p>
          <h1>外网溯源结果报告自动核验台</h1>
          <p className="hero-text">
            浏览器先定位并裁剪相互隔离的证书、网页截图、地址栏和汇总表区域；阿里云百炼的
            qwen3.7-plus 分阶段识别，最后由确定性规则复核网址、时间和字段一致性。
          </p>
          <div className="hero-actions">
            <button type="button" onClick={() => inputRef.current?.click()}>
              上传 PDF
            </button>
            <span>单文件最多 20 MiB / 80 页，每批最多 6 页。</span>
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
            <span>需人工复核</span>
            <strong>{reviewCount}</strong>
          </div>
          <div>
            <span>累计问题</span>
            <strong>{issueCount}</strong>
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
            原始 PDF 留在当前浏览器；只有定位用页面图和隔离后的证据裁剪图会发送到应用服务端及阿里云百炼。
            截图裁剪看不到汇总表，每条地址栏都使用 600 DPI 彩色与灰度增强图分别复核；图片不保存。
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
              <h2>浏览器历史</h2>
            </div>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setTasks(readStoredTasks());
                setCheckedTaskIds(new Set());
              }}
            >
              刷新
            </button>
          </div>

          <div className="history-controls">
            <label className="history-search">
              <span>搜索任务名称</span>
              <input
                type="search"
                value={historyQuery}
                placeholder="输入 PDF 名称"
                onChange={(event) => {
                  setHistoryQuery(event.currentTarget.value);
                  setCheckedTaskIds(new Set());
                }}
              />
            </label>
            <div className="history-date-controls">
              <label>
                <span>时间范围</span>
                <select
                  aria-label="时间范围"
                  value={historyDateFilter}
                  onChange={(event) => {
                    setHistoryDateFilter(
                      event.currentTarget.value as HistoryDateFilter,
                    );
                    setCheckedTaskIds(new Set());
                  }}
                >
                  <option value="all">全部时间</option>
                  <option value="today">今天</option>
                  <option value="7d">最近 7 天</option>
                  <option value="30d">最近 30 天</option>
                  <option value="custom">自定义日期</option>
                </select>
              </label>
              {historyDateFilter === "custom" ? (
                <>
                  <label>
                    <span>开始日期</span>
                    <input
                      type="date"
                      value={customStart}
                      onChange={(event) => {
                        setCustomStart(event.currentTarget.value);
                        setCheckedTaskIds(new Set());
                      }}
                    />
                  </label>
                  <label>
                    <span>结束日期</span>
                    <input
                      type="date"
                      value={customEnd}
                      onChange={(event) => {
                        setCustomEnd(event.currentTarget.value);
                        setCheckedTaskIds(new Set());
                      }}
                    />
                  </label>
                </>
              ) : null}
            </div>
          </div>

          <div className="history-batch-bar">
            <span>
              显示 {filteredTasks.length} / {tasks.length} 条
            </span>
            <div className="history-batch-actions">
              <button
                type="button"
                className="ghost"
                disabled={selectableFilteredIds.length === 0}
                onClick={toggleAllFilteredTasks}
              >
                {allFilteredChecked ? "取消全选" : "全选当前结果"}
              </button>
              <button
                type="button"
                className="danger-action"
                disabled={checkedDeletableIds.length === 0}
                onClick={() =>
                  deleteTaskIds(
                    new Set(checkedDeletableIds),
                    `确定删除选中的 ${checkedDeletableIds.length} 条历史任务吗？此操作无法撤销。`,
                  )
                }
              >
                批量删除
                {checkedDeletableIds.length > 0
                  ? `（${checkedDeletableIds.length}）`
                  : ""}
              </button>
            </div>
          </div>

          <div className="task-list">
            {tasks.length === 0 ? (
              <div className="empty">还没有任务。上传 PDF 后会显示在这里。</div>
            ) : filteredTasks.length === 0 ? (
              <div className="empty">没有符合条件的历史任务。</div>
            ) : (
              filteredTasks.map((task) => (
                <div
                  key={task.id}
                  className={`task-row ${task.id === selectedTask?.id ? "selected" : ""}`}
                >
                  <input
                    className="task-check"
                    type="checkbox"
                    aria-label={`选择任务：${task.fileName}`}
                    checked={checkedTaskIds.has(task.id)}
                    disabled={ACTIVE_STATUSES.has(task.status)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setCheckedTaskIds((current) => {
                        const next = new Set(current);
                        if (checked) next.add(task.id);
                        else next.delete(task.id);
                        return next;
                      });
                    }}
                  />
                  <button
                    type="button"
                    className="task-open"
                    aria-current={
                      task.id === selectedTask?.id ? "true" : undefined
                    }
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
                      {task.outcome
                        ? outcomeCopy[task.outcome]
                        : statusCopy[task.status]}
                      {task.issueCount !== null
                        ? ` · ${task.issueCount} 项`
                        : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="task-delete"
                    aria-label={`删除任务：${task.fileName}`}
                    disabled={ACTIVE_STATUSES.has(task.status)}
                    onClick={() =>
                      deleteTaskIds(
                        new Set([task.id]),
                        `确定删除任务“${task.fileName}”吗？此操作无法撤销。`,
                      )
                    }
                  >
                    删除任务
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        <section className="result-panel" aria-label="核验结果">
          {!selectedTask ? (
            <div className="empty large">选择一个历史任务查看结果。</div>
          ) : (
            <>
              <div className="result-header">
                <div>
                  <p className="eyebrow">Qwen Result</p>
                  <h2>{selectedTask.fileName}</h2>
                  <p>
                    {statusCopy[selectedTask.status]} · qwen3.7-plus · 最近更新：
                    {formatTime(selectedTask.updatedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void runTask(selectedTask.id)}
                  disabled={ACTIVE_STATUSES.has(selectedTask.status)}
                >
                  重新处理
                </button>
              </div>

              <div className="progress-track" aria-label="处理进度">
                <span style={{ width: `${selectedTask.progress}%` }} />
              </div>
              {selectedTask.totalPages ? (
                <p className="progress-copy">
                  已处理 {selectedTask.processedPages} / {selectedTask.totalPages} 页
                </p>
              ) : null}

              {selectedTask.outcome ? (
                <div className={`outcome-banner ${selectedTask.outcome}`}>
                  <strong>{outcomeCopy[selectedTask.outcome]}</strong>
                  <span>
                    {selectedTask.outcome === "needs_review"
                      ? "识别证据不完整或置信度不足，不能判定为无错误。"
                      : selectedTask.outcome === "passed"
                        ? "模型提取完整，确定性规则未发现问题。"
                        : selectedTask.outcome === "issues_found"
                          ? "模型提取完整，确定性规则发现下列问题。"
                          : "本次任务未生成可用结果。"}
                  </span>
                </div>
              ) : null}

              {selectedTask.summary ? (
                <div className="summary-grid">
                  <div>
                    <span>页数</span>
                    <strong>{selectedTask.summary.pageCount}</strong>
                  </div>
                  <div>
                    <span>权利字段</span>
                    <strong>{selectedTask.summary.rightsFieldCount}</strong>
                  </div>
                  <div>
                    <span>结果组</span>
                    <strong>{selectedTask.summary.groupCount}</strong>
                  </div>
                  <div>
                    <span>表格行</span>
                    <strong>{selectedTask.summary.tableRowCount}</strong>
                  </div>
                </div>
              ) : null}

              {selectedTask.errorMessage ? (
                <div className="error-box">{selectedTask.errorMessage}</div>
              ) : null}

              {selectedTask.summary?.warnings.length ? (
                <div className="warning-box">
                  <h3>处理警告</h3>
                  <ul>
                    {selectedTask.summary.warnings.map((warning, index) => (
                      <li key={`${index}-${warning}`}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {selectedTask.report?.verificationNotices.length ? (
                <div className="warning-box">
                  <h3>人工复核项</h3>
                  <ul>
                    {selectedTask.report.verificationNotices.map(
                      (noticeItem, index) => (
                        <li key={`${noticeItem.code}-${index}`}>
                          {noticeItem.message}
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              ) : null}

              {selectedTask.report?.issues.length ? (
                <div className="issues">
                  <h3>问题列表</h3>
                  {selectedTask.report.issues.map((issue, index) => (
                    <article key={`${issue.code}-${index}`}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{issue.code}</strong>
                        <p>{issue.message}</p>
                      </div>
                    </article>
                  ))}
                </div>
              ) : selectedTask.outcome === "passed" ? (
                <div className="success-box">经核查，当前 PDF 未发现规则问题。</div>
              ) : null}

              <div className="report-block">
                <h3>完整中文报告</h3>
                <pre>
                  {selectedTask.reportText ??
                    (ACTIVE_STATUSES.has(selectedTask.status)
                      ? "qwen3.7-plus 正在处理，请稍候..."
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
