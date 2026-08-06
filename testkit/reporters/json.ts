/**
 * JSON report (13.1).
 */
import type { RunResult } from "../types.js";
import { describeProvider } from "../providers.js";

export function renderJsonReport(result: RunResult): string {
  const summary = summarize(result);
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      summary,
      budget: result.budget,
      results: result.results.map((r) => ({
        scenarioId: r.scenarioId,
        providerId: r.providerId,
        status: r.status,
        skipReason: r.skipReason ?? undefined,
        durationMs: r.durationMs,
        error: r.error ?? undefined,
        requestCount: r.requestCount,
      })),
    },
    null,
    2,
  );
}

export function summarize(result: RunResult): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failedIds: string[];
} {
  const passed = result.results.filter((r) => r.status === "passed").length;
  const failed = result.results.filter((r) => r.status === "failed").length;
  const skipped = result.results.filter((r) => r.status === "skipped").length;
  return {
    total: result.results.length,
    passed,
    failed,
    skipped,
    failedIds: result.results
      .filter((r) => r.status === "failed")
      .map((r) => r.scenarioId),
  };
}

/** Human-readable one-line provider summary (keys masked). */
export function describeProviders(providers: Array<{ id: string }>): string {
  return providers.map((p) => p.id).join(", ");
}

export { describeProvider };
