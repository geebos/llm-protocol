/**
 * M5 testkit tests: provider config, offline matrix, budget, tags, capability
 * gating, live-skip, reports.
 */
import { describe, expect, it } from "vitest";
import {
  runMatrix,
  parseProviderConfig,
  loadBuiltinProviders,
  offlineScenariosFor,
  liveScenariosFor,
  renderJsonReport,
  renderJunitXml,
  renderMarkdownReport,
  type ProviderConfig,
} from "../testkit/index.js";
import type { Scenario } from "../testkit/types.js";

const anthropicProvider: ProviderConfig = parseProviderConfig({
  id: "test-anthropic",
  protocol: "anthropic-messages",
  baseUrl: "https://mock.invalid",
  apiKeyEnv: "TEST_ANTHROPIC_KEY",
  model: "claude-test",
  capabilities: ["stream", "tools", "parallel_tools", "thinking"],
});

const openaiProvider: ProviderConfig = parseProviderConfig({
  id: "test-openai",
  protocol: "openai-chat",
  baseUrl: "https://mock.invalid",
  apiKeyEnv: "TEST_OPENAI_KEY",
  model: "gpt-test",
  capabilities: ["stream", "tools"],
});

describe("provider config (10.2)", () => {
  it("parses and masks keys", async () => {
    process.env.TEST_ANTHROPIC_KEY = "sk-ant-super-secret-value";
    const p = parseProviderConfig({
      id: "a",
      protocol: "anthropic-messages",
      apiKeyEnv: "TEST_ANTHROPIC_KEY",
      model: "m",
      capabilities: ["stream", "tools"],
    });
    expect(p.protocol).toBe("anthropic-messages");
    expect(p.capabilities).toContain("stream");
  });

  it("rejects unknown protocols", () => {
    expect(() =>
      parseProviderConfig({
        id: "b",
        protocol: "bogus",
        apiKeyEnv: "X",
        model: "m",
        capabilities: [],
      }),
    ).toThrow(/protocol/);
  });

  it("builtin providers cover the three required categories (10.3)", () => {
    const builtins = loadBuiltinProviders();
    const protocols = builtins.map((p) => p.protocol);
    expect(protocols).toContain("anthropic-messages");
    expect(protocols).toContain("openai-chat");
    expect(builtins.length).toBeGreaterThanOrEqual(3);
  });
});

describe("offline fixture matrix (10.4)", () => {
  it("passes text, stream, tool and thinking scenarios for an Anthropic provider", async () => {
    const result = await runMatrix({
      providers: [anthropicProvider],
      scenarioBuilder: (p) => offlineScenariosFor(p),
      offlineOnly: true,
    });
    const failed = result.results.filter((r) => r.status === "failed");
    expect(failed).toEqual([]);
    const ids = result.results.map((r) => r.scenarioId);
    expect(ids).toContain("test-anthropic:text");
    expect(ids).toContain("test-anthropic:text-stream");
    expect(ids).toContain("test-anthropic:tool");
    expect(ids).toContain("test-anthropic:tool-stream");
    expect(ids).toContain("test-anthropic:thinking-stream");
  });

  it("passes the OpenAI-provider matrix including error reverse translation", async () => {
    const result = await runMatrix({
      providers: [openaiProvider],
      scenarioBuilder: (p) => offlineScenariosFor(p),
      offlineOnly: true,
    });
    const failed = result.results.filter((r) => r.status === "failed");
    expect(failed).toEqual([]);
    const ids = result.results.map((r) => r.scenarioId);
    expect(ids).toContain("test-openai:text");
    expect(ids).toContain("test-openai:error-reverse");
    // no thinking capability -> thinking scenario skipped
    const thinking = result.results.find((r) => r.scenarioId === "test-openai:thinking-stream");
    expect(thinking?.status).toBe("skipped");
  });

  it("gates scenarios on provider capabilities (10.5)", async () => {
    const minimal: ProviderConfig = parseProviderConfig({
      id: "minimal",
      protocol: "openai-chat",
      baseUrl: "https://mock.invalid",
      apiKeyEnv: "MINIMAL_KEY",
      model: "m",
      capabilities: [],
    });
    const result = await runMatrix({
      providers: [minimal],
      scenarioBuilder: (p) => offlineScenariosFor(p),
      offlineOnly: true,
    });
    // text + error-reverse run; stream/tool/thinking skipped
    expect(result.results.find((r) => r.scenarioId === "minimal:text")?.status).toBe("passed");
    expect(result.results.find((r) => r.scenarioId === "minimal:text-stream")?.status).toBe("skipped");
    expect(result.results.find((r) => r.scenarioId === "minimal:tool")?.status).toBe("skipped");
  });

  it("honors tag filtering", async () => {
    const result = await runMatrix({
      providers: [anthropicProvider],
      scenarioBuilder: (p) => offlineScenariosFor(p),
      offlineOnly: true,
      tags: ["stream"],
    });
    expect(result.results.every((r) => r.scenarioId.includes("stream"))).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });
});

describe("budget and live gating (10.6)", () => {
  it("stops at the request budget and skips the rest", async () => {
    const result = await runMatrix({
      providers: [anthropicProvider],
      scenarioBuilder: (p) => offlineScenariosFor(p),
      offlineOnly: true,
      budget: { maxRequests: 1 },
    });
    expect(result.budget?.requestUsed).toBe(1);
    expect(result.results.some((r) => r.skipReason === "budget exhausted")).toBe(true);
  });

  it("skips live scenarios without a key (never fails)", async () => {
    delete process.env.TEST_ANTHROPIC_KEY;
    const result = await runMatrix({
      providers: [anthropicProvider],
      scenarioBuilder: (p) => liveScenariosFor(p),
    });
    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) {
      expect(r.status).toBe("skipped");
      expect(r.skipReason).toMatch(/TEST_ANTHROPIC_KEY/);
    }
  });

  it("skips live scenarios in offline-only mode", async () => {
    process.env.TEST_ANTHROPIC_KEY = "sk-ant-live-key";
    const result = await runMatrix({
      providers: [anthropicProvider],
      scenarioBuilder: (p) => liveScenariosFor(p),
      offlineOnly: true,
    });
    for (const r of result.results) {
      expect(r.status).toBe("skipped");
    }
    delete process.env.TEST_ANTHROPIC_KEY;
  });
});

describe("reports (13.1)", () => {
  it("renders JSON, JUnit and Markdown from a run result", async () => {
    const result = await runMatrix({
      providers: [anthropicProvider],
      scenarioBuilder: (p) => offlineScenariosFor(p),
      offlineOnly: true,
      tags: ["text"],
    });
    const json = renderJsonReport(result);
    const parsed = JSON.parse(json) as { summary: { passed: number; failed: number; skipped: number } };
    expect(parsed.summary.passed).toBeGreaterThan(0);
    // no secrets in the report
    expect(json).not.toContain("sk-ant-");

    const junit = renderJunitXml(result);
    expect(junit).toContain("<testsuites");
    expect(junit).toContain("testcase");

    const md = renderMarkdownReport(result);
    expect(md).toContain("# llm-protocol 兼容性报告");
    expect(md).toContain("| 场景 |");
  });

  it("marks failed scenarios in the report", async () => {
    const failingScenario: Scenario = {
      id: "x:must-fail",
      title: "Failing scenario",
      tags: ["offline"],
      requires: [],
      fixture: {
        requestFile: "requests/anthropic-text.json",
        responseFile: "responses/openai-text.json",
        streaming: false,
      },
      assert: () => {
        throw new Error("boom");
      },
    };
    const result = await runMatrix({
      providers: [openaiProvider],
      scenarioBuilder: () => [failingScenario],
      offlineOnly: true,
    });
    const r = result.results[0];
    expect(r.status).toBe("failed");
    expect(r.error).toContain("boom");
    expect(renderJsonReport(result)).toContain("boom");
  });
});
