import { openTaskDatabase } from "../lib/server/task-database";
import { TaskRepository } from "../lib/server/task-repository";
import {
  createTaskWorkerFromEnv,
  requireDataDir,
  TaskWorkerConfigurationError,
} from "../lib/server/task-worker";

async function runWorker() {
  const database = openTaskDatabase(requireDataDir(process.env));
  try {
    const repository = new TaskRepository(database);
    const worker = createTaskWorkerFromEnv(repository);
    const controller = new AbortController();

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => controller.abort(signal));
    }

    try {
      await worker.start(controller.signal);
    } finally {
      await worker.stop();
    }
  } finally {
    database.close();
  }
}

try {
  await runWorker();
} catch (error) {
  console.error(
    error instanceof TaskWorkerConfigurationError
      ? error.message
      : "Audit worker failed to start.",
  );
  process.exitCode = 1;
}
