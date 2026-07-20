import { taskApiFromEnv } from "@/lib/server/task-api";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return taskApiFromEnv().list(request);
}

export async function POST(request: Request) {
  return taskApiFromEnv().create(request);
}
