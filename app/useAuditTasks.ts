"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TaskApiClientError,
  deleteTask,
  deleteTasks,
  getTask,
  importLegacyTasks,
  isTaskAbortError,
  listTasks,
  retryTask,
  uploadTask,
} from "@/lib/client/task-api";
import {
  SharedUploadQueue,
  TaskPollingController,
  TaskViewState,
  browserPollingEnvironment,
  detailFromTaskSummary,
  isActiveTask,
} from "@/lib/client/task-coordinator";
import {
  historyFiltersToTaskListFilters,
  migrateLegacyTaskHistory,
  type HistoryFilterOptions,
} from "@/lib/client/task-history";
import type { AuditTaskDetail, AuditTaskSummary } from "@/lib/types";

const MAX_PARALLEL_UPLOADS = 3;
const PDF_NOT_AVAILABLE_MESSAGE = "原始 PDF 已超过 3 天保留期，请重新上传文件。";

function taskErrorMessage(error: unknown) {
  if (
    error instanceof TaskApiClientError &&
    (error.code === "PDF_NOT_AVAILABLE" || error.code === "PDF_UNAVAILABLE")
  ) {
    return PDF_NOT_AVAILABLE_MESSAGE;
  }
  return error instanceof Error
    ? error.message
    : "任务服务暂时不可用，请稍后重试。";
}

export function useAuditTasks(filters: HistoryFilterOptions) {
  const [tasks, setTasks] = useState<AuditTaskDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [debouncedFilters, setDebouncedFilters] = useState(filters);
  const [viewState] = useState(() => new TaskViewState());
  const listSequenceRef = useRef(0);
  const migrationAttemptedRef = useRef(false);
  const mountedRef = useRef(false);
  const actionControllersRef = useRef(new Set<AbortController>());
  const uploadQueueRef = useRef<SharedUploadQueue<File, AuditTaskSummary> | null>(null);

  const publish = useCallback(() => {
    if (mountedRef.current) setTasks([...viewState.visibleTasks()]);
  }, [viewState]);

  useEffect(() => {
    mountedRef.current = true;
    const queue = new SharedUploadQueue<File, AuditTaskSummary>(MAX_PARALLEL_UPLOADS);
    uploadQueueRef.current = queue;
    const unsubscribe = queue.subscribe((snapshot) => {
      if (mountedRef.current) setUploading(snapshot.busy);
    });
    const controllers = actionControllersRef.current;
    return () => {
      mountedRef.current = false;
      unsubscribe();
      queue.abort();
      if (uploadQueueRef.current === queue) uploadQueueRef.current = null;
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  const runWithActionController = useCallback(<T,>(
    action: (signal: AbortSignal) => Promise<T>,
  ) => {
    const controller = new AbortController();
    actionControllersRef.current.add(controller);
    let running: Promise<T>;
    try {
      running = action(controller.signal);
    } catch (error) {
      actionControllersRef.current.delete(controller);
      return Promise.reject(error);
    }
    return running.finally(() => {
      actionControllersRef.current.delete(controller);
    });
  }, []);

  useEffect(() => {
    const nextFilters = {
      query: filters.query,
      dateFilter: filters.dateFilter,
      customStart: filters.customStart,
      customEnd: filters.customEnd,
    };
    const timer = window.setTimeout(() => setDebouncedFilters(nextFilters), 250);
    return () => window.clearTimeout(timer);
  }, [
    filters.customEnd,
    filters.customStart,
    filters.dateFilter,
    filters.query,
  ]);

  useEffect(() => {
    const sequence = ++listSequenceRef.current;
    const controller = new AbortController();
    const query = historyFiltersToTaskListFilters(debouncedFilters);
    const read = viewState.beginList(query);
    queueMicrotask(() => {
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        sequence === listSequenceRef.current
      ) {
        publish();
        setLoading(true);
      }
    });
    void listTasks(query, undefined, controller.signal)
      .then((result) => {
        if (
          !mountedRef.current ||
          sequence !== listSequenceRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        const details = result.items.map((summary) =>
          detailFromTaskSummary(summary, viewState.task(summary.id)),
        );
        viewState.completeList(details, read);
        publish();
      })
      .catch((error: unknown) => {
        if (
          mountedRef.current &&
          !controller.signal.aborted &&
          sequence === listSequenceRef.current &&
          !isTaskAbortError(error)
        ) {
          setNotice(taskErrorMessage(error));
        }
      })
      .finally(() => {
        if (
          mountedRef.current &&
          !controller.signal.aborted &&
          sequence === listSequenceRef.current
        ) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [debouncedFilters, publish, refreshVersion, viewState]);

  useEffect(() => {
    if (migrationAttemptedRef.current) return;
    migrationAttemptedRef.current = true;
    const controller = new AbortController();
    let finished = false;
    void migrateLegacyTaskHistory(window.localStorage, (legacyTasks) =>
      importLegacyTasks(legacyTasks, undefined, controller.signal),
    )
      .then((result) => {
        finished = true;
        if (mountedRef.current && result.status === "imported") {
          setRefreshVersion((value) => value + 1);
        }
      })
      .catch((error: unknown) => {
        finished = true;
        if (
          mountedRef.current &&
          !controller.signal.aborted &&
          !isTaskAbortError(error)
        ) {
          setNotice(taskErrorMessage(error));
        }
      });
    return () => {
      controller.abort();
      if (!finished) migrationAttemptedRef.current = false;
    };
  }, []);

  const activeTaskIds = useMemo(
    () => tasks.filter(isActiveTask).map((task) => task.id),
    [tasks],
  );
  const activeTaskKey = activeTaskIds.join("\0");

  useEffect(() => {
    if (!activeTaskKey) return;
    const taskIds = activeTaskKey.split("\0");
    const controller = new TaskPollingController({
      taskIds,
      environment: browserPollingEnvironment(),
      fetchTask: async (id, signal) => {
        const token = viewState.beginRead(id);
        return { task: await getTask(id, undefined, signal), token };
      },
      onTask: ({ task, token }) => {
        if (viewState.applyRead(task, token)) publish();
      },
      onError: (error) => {
        if (mountedRef.current && !isTaskAbortError(error)) {
          setNotice(taskErrorMessage(error));
        }
      },
    });
    controller.start();
    return () => controller.stop();
  }, [activeTaskKey, publish, viewState]);

  const refresh = useCallback(() => {
    setRefreshVersion((value) => value + 1);
  }, []);

  const uploadFiles = useCallback(
    (input: FileList | readonly File[]) => {
      const accepted = Array.from(input).filter(
        (file) =>
          file.type === "application/pdf" ||
          file.name.toLocaleLowerCase().endsWith(".pdf"),
      );
      if (accepted.length === 0) {
        if (mountedRef.current) setNotice("请上传 PDF 文件。");
        return Promise.resolve();
      }
      const queue = uploadQueueRef.current;
      if (!queue) return Promise.resolve();
      if (mountedRef.current) {
        setNotice(`已接收 ${accepted.length} 个 PDF，正在私密上传到服务器。`);
      }
      return queue
        .enqueue(accepted, async (file, signal) => {
          const summary = await uploadTask(file, undefined, signal);
          if (mountedRef.current) {
            const token = viewState.beginAction(summary.id);
            viewState.applyAction(
              detailFromTaskSummary(summary, viewState.task(summary.id)),
              token,
              true,
            );
            publish();
          }
          return summary;
        })
        .then((results) => {
          if (!mountedRef.current) return;
          const succeeded = results.filter(
            (result) => result.status === "fulfilled",
          ).length;
          const rejected = results.filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected" && !isTaskAbortError(result.reason),
          );
          if (rejected.length > 0) {
            setNotice(
              succeeded > 0
                ? `已上传 ${succeeded} 个 PDF，${rejected.length} 个上传失败：${taskErrorMessage(rejected[0]?.reason)}`
                : taskErrorMessage(rejected[0]?.reason),
            );
          } else if (succeeded > 0) {
            setNotice(`已上传 ${succeeded} 个 PDF，任务已进入服务器队列。`);
          }
        });
    },
    [publish, viewState],
  );

  const retry = useCallback(
    async (id: string) => {
      const token = viewState.beginAction(id);
      try {
        const summary = await runWithActionController((signal) =>
          retryTask(id, undefined, signal),
        );
        if (!mountedRef.current) return;
        viewState.applyAction(
          detailFromTaskSummary(summary, viewState.task(summary.id)),
          token,
          false,
        );
        publish();
        setNotice("任务已重新进入服务器队列。");
      } catch (error) {
        if (mountedRef.current && !isTaskAbortError(error)) {
          setNotice(taskErrorMessage(error));
        }
      }
    },
    [publish, runWithActionController, viewState],
  );

  const remove = useCallback(
    async (requestedIds: ReadonlySet<string>, confirmation: string) => {
      const deletableIds = viewState
        .visibleTasks()
        .filter((task) => requestedIds.has(task.id) && !isActiveTask(task))
        .map((task) => task.id);
      if (deletableIds.length === 0) {
        if (mountedRef.current) setNotice("处理中任务不能删除。");
        return [];
      }
      if (!window.confirm(confirmation)) return [];
      const tokens = new Map(
        deletableIds.map((id) => [id, viewState.beginAction(id)]),
      );
      try {
        const deleted = await runWithActionController(async (signal) => {
          if (deletableIds.length === 1) {
            await deleteTask(deletableIds[0], undefined, signal);
            return deletableIds;
          }
          return deleteTasks(deletableIds, undefined, signal);
        });
        if (!mountedRef.current) return [];
        for (const id of deleted) {
          const token = tokens.get(id);
          if (token) viewState.markDeleted(id, token);
        }
        publish();
        setNotice(`已删除 ${deleted.length} 条历史任务。`);
        return deleted;
      } catch (error) {
        if (mountedRef.current && !isTaskAbortError(error)) {
          setNotice(taskErrorMessage(error));
        }
        return [];
      }
    },
    [publish, runWithActionController, viewState],
  );

  const loadTaskDetails = useCallback(
    (id: string) => {
      const controller = new AbortController();
      const token = viewState.beginRead(id);
      actionControllersRef.current.add(controller);
      void getTask(id, undefined, controller.signal)
        .then((task) => {
          if (
            mountedRef.current &&
            !controller.signal.aborted &&
            viewState.applyRead(task, token)
          ) {
            publish();
          }
        })
        .catch((error: unknown) => {
          if (
            mountedRef.current &&
            !controller.signal.aborted &&
            !isTaskAbortError(error)
          ) {
            setNotice(taskErrorMessage(error));
          }
        })
        .finally(() => actionControllersRef.current.delete(controller));
      return () => {
        controller.abort();
        actionControllersRef.current.delete(controller);
      };
    },
    [publish, viewState],
  );

  return {
    tasks,
    loading,
    uploading,
    notice,
    setNotice,
    refresh,
    uploadFiles,
    retry,
    remove,
    loadTaskDetails,
  };
}
