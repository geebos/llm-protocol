/**
 * JUnit XML report (13.1).
 */
import type { RunResult } from "../types.js";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderJunitXml(result: RunResult): string {
  const suites = new Map<string, RunResult["results"]>();
  for (const r of result.results) {
    const key = r.providerId;
    suites.set(key, [...(suites.get(key) ?? []), r]);
  }
  const suitesXml = [...suites.entries()]
    .map(([providerId, results]) => {
      const tests = results.length;
      const failures = results.filter((r) => r.status === "failed").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const time = results.reduce((a, r) => a + r.durationMs, 0) / 1000;
      const cases = results
        .map((r) => {
          const base = `classname="llm-protocol.compat" name="${escapeXml(r.scenarioId)}" time="${(r.durationMs / 1000).toFixed(3)}"`;
          if (r.status === "failed") {
            return `    <testcase ${base}>\n      <failure message="${escapeXml(r.error ?? "failed")}"/>\n    </testcase>`;
          }
          if (r.status === "skipped") {
            return `    <testcase ${base}>\n      <skipped message="${escapeXml(r.skipReason ?? "skipped")}"/>\n    </testcase>`;
          }
          return `    <testcase ${base}/>`;
        })
        .join("\n");
      return [
        `  <testsuite name="${escapeXml(providerId)}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}">`,
        cases,
        "  </testsuite>",
      ].join("\n");
    })
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="llm-protocol compat" tests="${result.results.length}" failures="${result.results.filter((r) => r.status === "failed").length}">`,
    suitesXml,
    `</testsuites>`,
    "",
  ].join("\n");
}
