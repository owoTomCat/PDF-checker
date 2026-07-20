import { taskApiFromEnv } from "@/lib/server/task-api";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return taskApiFromEnv().retry(request, id);
}
