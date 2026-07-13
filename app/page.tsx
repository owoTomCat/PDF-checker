import type { Metadata } from "next";
import { AuditConsole } from "./AuditConsole";

export const metadata: Metadata = {
  title: "PDF 外网溯源报告核验",
  description:
    "使用 qwen3.7-plus 识别外网溯源结果报告，并生成可人工复核的核验结论。",
};

export default function Home() {
  return <AuditConsole />;
}
