import type { Metadata } from "next";
import { AuditConsole } from "./AuditConsole";

export const metadata: Metadata = {
  title: "PDF 外网溯源报告核验",
  description:
    "上传外网溯源结果报告 PDF，后台生成核验任务并保存历史结果。",
};

export default function Home() {
  return <AuditConsole />;
}
