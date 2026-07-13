import { NextResponse } from "next/server";
import { runAuditFromPdf } from "@/lib/audit-runner";
import {
  completeTask,
  failTask,
  getPdfBucket,
  getTask,
  getTaskRecord,
  markTaskProcessing,
} from "@/lib/server/storage";

export const runtime = "edge";

function taskIdFromRequest(request: Request) {
  const parts = new URL(request.url).pathname.split("/");
  return decodeURIComponent(parts[3] ?? "");
}

export async function POST(request: Request) {
  const id = taskIdFromRequest(request);

  try {
    const record = await getTaskRecord(id);
    if (!record) {
      return NextResponse.json({ error: "任务不存在。" }, { status: 404 });
    }

    await markTaskProcessing(id);
    const object = await getPdfBucket().get(record.object_key);
    if (!object) {
      throw new Error("未找到已上传的 PDF 文件。");
    }

    const { reportText, storedResult } = await runAuditFromPdf(
      await object.arrayBuffer(),
    );

    await completeTask(id, reportText, storedResult, storedResult.summary);
    const task = await getTask(id);
    return NextResponse.json({ task });
  } catch (error) {
    const message = error instanceof Error ? error.message : "任务处理失败。";
    await failTask(id, message).catch(() => undefined);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
