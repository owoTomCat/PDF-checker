"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TaskApiClientError,
  deleteTask,
  deleteTasks,
  getTask,
  importLegacyTasks,
  listTasks,
  retryTask,
  uploadTask,
} from "@/lib/client/task-api";
import {
  TaskPollingController,
  browserPollingEnvironment,
  isActiveTask,
  mergeTaskByFreshness,
  runReleasingUploadQueue,
} from "@/lib/client/task-coordinator";
import {
  historyFiltersToTaskListFilters,
  migrateLegacyTaskHistory,
  removeHistoryTasks,
  upsertHistoryTask,
  type HistoryFilterOptions,
} from "@/lib/client/task-history";
import type { AuditTaskDetail, AuditTaskSummary } from "@/lib/types";

const MAX_PARALLEL_UPLOADS = 3;
const PDF_NOT_AVAILABLE_MESSAGE = "原始 PDF 已超过 3 天保留期，请重新上传文件。";

function detailFromSummary(
  summary: AuditTaskSummary,
  previous?: AuditTaskDetail,
): AuditTaskDetail {
  const preserveReport =
    previous && !isActiveTask(previous) && !isActiveTask(summary);
  return {
    ...summary,
    reportText: preserveReport ? previous.reportText : null,
    report: preserveReport ? previous.report : null,
  };
}

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
  const listSequenceRef = useRef(0);
  const stateVersionRef = useRef(0);
  const taskVersionRef = useRef(new Map<string, number>());
  const deletedVersionRef = useRef(new Map<string, number>());
  const migrationAttemptedRef = useRef(false);
  const actionControllersRef = useRef(new Set<AbortController>());
  const tasksRef = useRef(tasks);

  useEffect(() => {
    const controllers = actionControllersRef.current;
    return () => {
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

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

  const applyDetail = useCallback((incoming: AuditTaskDetail) => {
    if (deletedVersionRef.current.has(incoming.id)) return;
    const version = ++stateVersionRef.current;
    taskVersionRef.current.set(incoming.id, version);
    setTasks((current) => {
      const existing = current.find((task) => task.id === incoming.id);
      return upsertHistoryTask(
        current,
        mergeTaskByFreshness(existing, incoming),
      );
    });
  }, []);

  const applySummary = useCallback((summary: AuditTaskSummary) => {
    const version = ++stateVersionRef.current;
    taskVersionRef.current.set(summary.id, version);
    deletedVersionRef.current.delete(summary.id);
    setTasks((current) => {
      const existing = current.find((task) => task.id === summary.id);
      const incoming = detailFromSummary(summary, existing);
      return upsertHistoryTask(current, mergeTaskByFreshness(existing, incoming));
    });
  }, []);

  useEffect(() => {
    const sequence = ++listSequenceRef.current;
    const requestStateVersion = stateVersionRef.current;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted && sequence === listSequenceRef.current) {
        setLoading(true);
      }
    });
    const query = historyFiltersToTaskListFilters(debouncedFilters);
    void listTasks(query, undefined, controller.signal)
      .then((result) => {
        if (sequence !== listSequenceRef.current || controller.signal.aborted) return;
        setTasks((current) => {
          const currentById = new Map(current.map((task) => [task.id, task]));
          const returnedIds = new Set(result.items.map((item) => item.id));
          const listed = result.items.flatMap((summary) => {
            const deletedAt = deletedVersionRef.current.get(summary.id) ?? 0;
            if (deletedAt > requestStateVersion) return [];
            const existing = currentById.get(summary.id);
            const incoming = detailFromSummary(summary, existing);
            return [mergeTaskByFreshness(existing, incoming)];
          });
          const locallyUpdated = current.filter((task) => {
            if (returnedIds.has(task.id)) return false;
            return (taskVersionRef.current.get(task.id) ?? 0) > requestStateVersion;
          });
          return [...listed, ...locallyUpdated].sort(
            (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
          );
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && sequence === listSequenceRef.current) {
          setNotice(taskErrorMessage(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && sequence === listSequenceRef.current) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [debouncedFilters, refreshVersion]);

  useEffect(() => {
    if (migrationAttemptedRef.current) return;
    migrationAttemptedRef.current = true;
    const controller = new AbortController();
    let finished = false;
    void migrateLegacyTaskHistory(window.localStorage, (legacyTasks) =>
      importLegacyTasks(
        legacyTasks,
        undefined,
        controller.signal,
      ),
    )
      .then((result) => {
        finished = true;
        if (result.status === "imported") setRefreshVersion((value) => value + 1);
      })
      .catch((error: unknown) => {
        finished = true;
        if (!controller.signal.aborted) {
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
      fetchTask: (id, signal) => getTask(id, undefined, signal),
      onTask: applyDetail,
      onError: (error) => setNotice(taskErrorMessage(error)),
    });
    controller.start();
    return () => controller.stop();
  }, [activeTaskKey, applyDetail]);

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
        setNotice("请上传 PDF 文件。");
        return Promise.resolve();
      }
      setUploading(true);
      setNotice(`已接收 ${accepted.length} 个 PDF，正在私密上传到服务器。`);
      const running = runWithActionController((signal) =>
        runReleasingUploadQueue(
          accepted,
          MAX_PARALLEL_UPLOADS,
          async (file) => {
            const task = await uploadTask(file, undefined, signal);
            applySummary(task);
            return task;
          },
        ),
      );
      return running.then((results) => {
        const succeeded = results.filter((result) => result.status === "fulfilled").length;
        const failed = results.length - succeeded;
        setUploading(false);
        if (failed > 0) {
          const rejected = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          setNotice(
            succeeded > 0
              ? `已上传 ${succeeded} 个 PDF，${failed} 个上传失败：${taskErrorMessage(rejected?.reason)}`
              : taskErrorMessage(rejected?.reason),
          );
        } else {
          setNotice(`已上传 ${succeeded} 个 PDF，任务已进入服务器队列。`);
        }
      });
    },
    [applySummary, runWithActionController],
  );

  const retry = useCallback(
    async (id: string) => {
      try {
        const task = await runWithActionController((signal) =>
          retryTask(id, undefined, signal),
        );
        applySummary(task);
        setNotice("任务已重新进入服务器队列。");
      } catch (error) {
        setNotice(taskErrorMessage(error));
      }
    },
    [applySummary, runWithActionController],
  );

  const remove = useCallback(
    async (requestedIds: ReadonlySet<string>, confirmation: string) => {
      const deletableIds = tasksRef.current
        .filter((task) => requestedIds.has(task.id) && !isActiveTask(task))
        .map((task) => task.id);
      if (deletableIds.length === 0) {
        setNotice("处理中任务不能删除。");
        return [];
      }
      if (!window.confirm(confirmation)) return [];
      try {
        const deleted = await runWithActionController(async (signal) => {
          if (deletableIds.length === 1) {
            await deleteTask(deletableIds[0], undefined, signal);
            return deletableIds;
          }
          return deleteTasks(deletableIds, undefined, signal);
        });
        const version = ++stateVersionRef.current;
        for (const id of deleted) {
          deletedVersionRef.current.set(id, version);
          taskVersionRef.current.delete(id);
        }
        const deletedSet = new Set(deleted);
        setTasks((current) => removeHistoryTasks(current, deletedSet));
        setNotice(`已删除 ${deleted.length} 条历史任务。`);
        return deleted;
      } catch (error) {
        setNotice(taskErrorMessage(error));
        return [];
      }
    },
    [runWithActionController],
  );

  const loadTaskDetails = useCallback(
    (id: string) => {
      const controller = new AbortController();
      actionControllersRef.current.add(controller);
      void getTask(id, undefined, controller.signal)
        .then((task) => {
          if (!controller.signal.aborted) applyDetail(task);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setNotice(taskErrorMessage(error));
        })
        .finally(() => actionControllersRef.current.delete(controller));
      return () => {
        controller.abort();
        actionControllersRef.current.delete(controller);
      };
    },
    [applyDetail],
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
