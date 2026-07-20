import { taskApiFromEnv } from "@/lib/server/task-api";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return taskApiFromEnv().batchRemove(request);
}
