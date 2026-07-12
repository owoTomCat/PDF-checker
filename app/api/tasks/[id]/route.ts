import { NextResponse } from "next/server";
import { getTask } from "@/lib/server/storage";

export const runtime = "edge";

function taskIdFromRequest(request: Request) {
  const parts = new URL(request.url).pathname.split("/");
  return decodeURIComponent(parts[3] ?? "");
}

export async function GET(request: Request) {
  try {
    const task = await getTask(taskIdFromRequest(request));
    if (!task) {
      return NextResponse.json({ error: "任务不存在。" }, { status: 404 });
    }
    return NextResponse.json({ task });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取任务失败。" },
      { status: 500 },
    );
  }
}
