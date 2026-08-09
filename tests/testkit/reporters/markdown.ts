/**
 * Markdown compatibility report (13.1).
 */
import type { RunResult } from "../types.js";
import { summarize } from "./json.js";

export function renderMarkdownReport(result: RunResult): string {
  const s = summarize(result);
  const lines: string[] = [];
  lines.push("# llm-protocol 兼容性报告");
  lines.push("");
  lines.push(`生成时间：${result.startedAt}`);
  lines.push("");
  lines.push("## 摘要");
  lines.push("");
  lines.push(`| 总数 | 通过 | 失败 | 跳过 |`);
  lines.push(`| --- | --- | --- | --- |`);
  lines.push(`| ${s.total} | ${s.passed} | ${s.failed} | ${s.skipped} |`);
  if (result.budget) {
    lines.push("");
    lines.push(`请求预算：${result.budget.requestUsed}/${result.budget.maxRequests}`);
  }
  lines.push("");
  lines.push("## 明细");
  lines.push("");
  lines.push("| 场景 | Provider | 状态 | 耗时(ms) | 备注 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of result.results) {
    const note =
      r.status === "failed"
        ? (r.error ?? "").slice(0, 120)
        : r.status === "skipped"
          ? (r.skipReason ?? "")
          : `${r.requestCount} req`;
    lines.push(
      `| ${r.scenarioId} | ${r.providerId} | ${r.status} | ${r.durationMs} | ${note.replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
