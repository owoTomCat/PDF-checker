"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuditTasks } from "@/app/useAuditTasks";
import {
  ACTIVE_TASK_STATUSES,
  isActiveTask,
  removeCheckedTaskId,
} from "@/lib/client/task-coordinator";
import { type HistoryDateFilter } from "@/lib/client/task-history";
import type {
  AuditOutcome,
  TaskStatus,
} from "@/lib/types";

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

export function AuditConsole() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyDateFilter, setHistoryDateFilter] =
    useState<HistoryDateFilter>("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [checkedTaskIds, setCheckedTaskIds] = useState<Set<string>>(
    new Set(),
  );
  const filters = useMemo(
    () => ({
      query: historyQuery,
      dateFilter: historyDateFilter,
      customStart,
      customEnd,
    }),
    [customEnd, customStart, historyDateFilter, historyQuery],
  );
  const {
    tasks,
    loading,
    uploading,
    notice,
    refresh,
    uploadFiles: uploadServerFiles,
    retry,
    remove,
    loadTaskDetails,
  } = useAuditTasks(filters);
  const filteredTasks = tasks;

  const selectedTask = useMemo(
    () =>
      filteredTasks.find((task) => task.id === selectedId) ??
      filteredTasks[0] ??
      null,
    [filteredTasks, selectedId],
  );
  const selectedTaskId = selectedTask?.id ?? null;

  const selectableFilteredIds = useMemo(
    () =>
      filteredTasks
        .filter((task) => !isActiveTask(task))
        .map((task) => task.id),
    [filteredTasks],
  );

  const checkedDeletableIds = useMemo(
    () =>
      [...checkedTaskIds].filter((id) => {
        const task = tasks.find((item) => item.id === id);
        return task && !isActiveTask(task);
      }),
    [checkedTaskIds, tasks],
  );

  const allFilteredChecked =
    selectableFilteredIds.length > 0 &&
    selectableFilteredIds.every((id) => checkedTaskIds.has(id));

  useEffect(() => {
    if (selectedTaskId) return loadTaskDetails(selectedTaskId);
  }, [loadTaskDetails, selectedTaskId]);

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
    async (requestedIds: ReadonlySet<string>, confirmation: string) => {
      const deleted = await remove(requestedIds, confirmation);
      if (deleted.length === 0) return;
      const deletedSet = new Set(deleted);
      setCheckedTaskIds((current) => {
        const next = new Set(current);
        deleted.forEach((id) => next.delete(id));
        return next;
      });
      setSelectedId((current) =>
        current && deletedSet.has(current) ? null : current,
      );
    },
    [remove],
  );

  const activeCount = tasks.filter(isActiveTask).length;
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
            原始 PDF 私密上传到服务器后，由三路后台任务并行处理；阿里云百炼的
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
          const files = Array.from(event.dataTransfer.files);
          void uploadServerFiles(files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void uploadServerFiles(files);
          }}
        />
        <div className="upload-icon">PDF</div>
        <div>
          <h2>拖入或选择外网溯源报告</h2>
          <p>
            原始 PDF 会私密上传到服务器处理，本地副本默认保留 72 小时后自动清理；任务记录和核验报告继续保留。
            页面图和隔离后的证据裁剪图只在任务处理期间使用，不通过公开地址提供。
          </p>
        </div>
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? "上传中" : "选择文件"}
        </button>
      </section>

      {notice ? <p className="notice">{notice}</p> : null}

      <section className="workspace-grid">
        <aside className="task-panel" aria-label="历史任务">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">History</p>
              <h2>服务器历史</h2>
            </div>
            <button
              type="button"
              className="ghost"
              disabled={loading}
              onClick={() => {
                refresh();
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
            {loading && tasks.length === 0 ? (
              <div className="empty">正在读取服务器任务...</div>
            ) : tasks.length === 0 ? (
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
                    disabled={ACTIVE_TASK_STATUSES.has(task.status)}
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
                    disabled={ACTIVE_TASK_STATUSES.has(task.status)}
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
                  onClick={() => {
                    setCheckedTaskIds((current) =>
                      removeCheckedTaskId(current, selectedTask.id),
                    );
                    void retry(selectedTask.id);
                  }}
                  disabled={isActiveTask(selectedTask)}
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
                    (isActiveTask(selectedTask)
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
