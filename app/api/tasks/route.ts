import { NextResponse } from "next/server";
import {
  createTask,
  getPdfBucket,
  listTasks,
} from "@/lib/server/storage";

export const runtime = "edge";

export async function GET() {
  try {
    const tasks = await listTasks();
    return NextResponse.json({ tasks });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取任务失败。" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "请上传 PDF 文件。" }, { status: 400 });
    }

    if (
      file.type &&
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      return NextResponse.json({ error: "仅支持 PDF 文件。" }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const objectKey = `uploads/${id}.pdf`;
    const arrayBuffer = await file.arrayBuffer();

    await getPdfBucket().put(objectKey, arrayBuffer, {
      httpMetadata: { contentType: file.type || "application/pdf" },
      customMetadata: { originalName: file.name },
    });

    const task = await createTask({
      id,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || "application/pdf",
      objectKey,
    });

    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "创建任务失败。" },
      { status: 500 },
    );
  }
}
