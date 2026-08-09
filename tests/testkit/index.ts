/**
 * testkit public entry (M5).
 */
export { runMatrix } from "./runner.js";
export type { MatrixOptions } from "./runner.js";
export { parseProviderConfig, loadBuiltinProviders, hasProviderKey, describeProvider } from "./providers.js";
export type { RawProviderConfig } from "./providers.js";
export { offlineScenariosFor, converseProtocol } from "./scenarios/offline.js";
export { liveScenariosFor } from "./scenarios/live.js";
export { renderJsonReport, summarize } from "./reporters/json.js";
export { renderJunitXml } from "./reporters/junit.js";
export { renderMarkdownReport } from "./reporters/markdown.js";
export type {
  ProviderConfig,
  ProviderCapability,
  Scenario,
  ScenarioResult,
  RunResult,
  RunOptions,
  AssertionContext,
} from "./types.js";
