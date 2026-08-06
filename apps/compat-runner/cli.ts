#!/usr/bin/env node
/**
 * compat-runner CLI (13.1, 10.4).
 *
 * Runs the offline Fixture Contract matrix and (optionally) live smoke
 * scenarios against configured providers, and writes JSON / JUnit / Markdown
 * reports. Keys come only from environment variables; live scenarios are
 * skipped without a key.
 *
 * Usage:
 *   npm run compat -- --offline-only
 *   npm run compat -- --provider anthropic-native --tag stream
 *   npm run compat -- --budget 20 --reports-dir ./reports
 */
import "dotenv/config";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadBuiltinProviders, describeProvider, hasProviderKey } from "../../testkit/index.js";
import { offlineScenariosFor } from "../../testkit/scenarios/offline.js";
import { liveScenariosFor } from "../../testkit/scenarios/live.js";
import { runMatrix } from "../../testkit/index.js";
import { renderJsonReport } from "../../testkit/index.js";
import { renderJunitXml } from "../../testkit/index.js";
import { renderMarkdownReport } from "../../testkit/index.js";
import type { ProviderConfig } from "../../testkit/index.js";

interface CliArgs {
  provider?: string;
  tag?: string;
  offlineOnly: boolean;
  budget?: number;
  reportsDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { offlineOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offline-only") args.offlineOnly = true;
    else if (a === "--provider") args.provider = argv[++i];
    else if (a === "--tag") args.tag = argv[++i];
    else if (a === "--budget") args.budget = Number(argv[++i]);
    else if (a === "--reports-dir") args.reportsDir = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`
compat-runner — llm-protocol 兼容性测试 CLI

选项:
  --provider <id>     只运行指定 provider（默认全部）
  --tag <tag>         只运行带该标签的场景（text/stream/tool/thinking/error/offline/live）
  --offline-only      跳过 live（真实 API）场景
  --budget <n>        最大请求数（预算熔断）
  --reports-dir <dir> 报告输出目录（默认 ./reports）
  -h, --help          帮助
`);
      process.exit(0);
    }
  }
  return args;
}

/**
 * Warn when a shell-exported variable shadows a different .env value.
 * dotenv never overrides shell variables, so a stale shell export silently
 * wins over .env and can break provider key/baseUrl pairing (e.g. an
 * ANTHROPIC_BASE_URL shell export paired with an .env key for another relay).
 */
async function warnConfigShadowing(): Promise<void> {
  const CONFIG_KEYS = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_TEST_MODEL",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_TEST_MODEL",
    "COMPAT_A_BASE_URL",
    "COMPAT_A_API_KEY",
    "COMPAT_A_MODEL",
  ];
  let dotenvValues: Record<string, string> = {};
  try {
    const text = await readFile(".env", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) dotenvValues[m[1]] = m[2];
    }
  } catch {
    return; // no .env file
  }
  for (const key of CONFIG_KEYS) {
    const shell = process.env[key];
    const dot = dotenvValues[key];
    if (shell !== undefined && dot !== undefined && shell !== dot) {
      console.warn(
        `  ⚠ ${key} 被 shell 环境变量遮蔽: shell=${mask(shell)} .env=${mask(dot)}`,
      );
    }
  }
  function mask(v: string): string {
    return v.length > 12 ? `${v.slice(0, 6)}...${v.length}chars` : "****";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await warnConfigShadowing();
  const providers = loadBuiltinProviders();
  const selected = args.provider
    ? providers.filter((p) => p.id === args.provider)
    : providers;
  if (selected.length === 0) {
    console.error(`no provider matches "${args.provider}"`);
    process.exit(1);
  }

  console.log("== compat-runner ==");
  for (const p of selected) {
    const key = hasProviderKey(p) ? "key present" : "no key (live skipped)";
    console.log(`  - ${describeProvider(p)} [${key}]`);
  }

  const scenarioBuilder = (provider: ProviderConfig) => [
    ...offlineScenariosFor(provider),
    ...liveScenariosFor(provider),
  ];

  const result = await runMatrix({
    providers: selected,
    scenarioBuilder,
    offlineOnly: args.offlineOnly,
    budget: args.budget ? { maxRequests: args.budget } : undefined,
    tags: args.tag ? [args.tag] : undefined,
  });

  const summary = result.results.reduce(
    (acc, r) => {
      acc[r.status] += 1;
      return acc;
    },
    { passed: 0, failed: 0, skipped: 0 },
  );
  console.log(
    `\n结果: ${result.results.length} total | ${summary.passed} passed | ${summary.failed} failed | ${summary.skipped} skipped`,
  );
  for (const r of result.results) {
    if (r.status === "failed") {
      console.log(`  FAIL ${r.scenarioId}: ${r.error}`);
    } else if (r.status === "skipped") {
      console.log(`  skip ${r.scenarioId}: ${r.skipReason}`);
    }
  }

  const dir = resolve(process.cwd(), args.reportsDir ?? "reports");
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "compat.json"), renderJsonReport(result));
  await writeFile(resolve(dir, "compat.junit.xml"), renderJunitXml(result));
  await writeFile(resolve(dir, "compat.md"), renderMarkdownReport(result));
  console.log(`\n报告已写入 ${dir}/`);

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
