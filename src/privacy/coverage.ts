/**
 * Coverage Policy normalization (PR-010, §7.5).
 *
 * Defaults: text channels `redact`, `tool_schema` structural=allow /
 * text=redact / valueBearing=reject (reject only when a sensitive value is
 * actually detected), `reasoning=reject` (detection-gated), and extensions
 * `allow` (INV-10).
 */
import type {
  CoverageAction,
  PrivacyChannel,
  PrivacyCoveragePolicy,
  ToolSchemaCoverage,
} from "./types.js";

export interface NormalizedCoverage {
  system: CoverageAction;
  message_text: CoverageAction;
  tool_result: CoverageAction;
  tool_arguments: CoverageAction;
  tool_description: CoverageAction;
  reasoning: CoverageAction;
  toolSchema: Required<ToolSchemaCoverage>;
  extensionsDefault: CoverageAction;
  extensionPaths: Record<string, CoverageAction>;
  nativeDefault: CoverageAction;
  nativePaths: Record<string, CoverageAction>;
}

const VALID_ACTIONS: readonly CoverageAction[] = ["redact", "allow", "reject"];

function action(value: unknown, fallback: CoverageAction, field: string): CoverageAction {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (VALID_ACTIONS as readonly string[]).includes(value)) {
    return value as CoverageAction;
  }
  throw new Error(`invalid privacy coverage action for ${field}`);
}

export function normalizeCoverage(policy: PrivacyCoveragePolicy): NormalizedCoverage {
  let extensionsDefault: CoverageAction = "allow";
  let extensionPaths: Record<string, CoverageAction> = {};
  if (typeof policy.extensions === "string") {
    extensionsDefault = action(policy.extensions, "allow", "extensions");
  } else if (policy.extensions && typeof policy.extensions === "object") {
    extensionPaths = {};
    for (const [key, value] of Object.entries(policy.extensions)) {
      extensionPaths[key] = action(value, "allow", `extensions.${key}`);
    }
  }

  let nativeDefault: CoverageAction = "allow";
  let nativePaths: Record<string, CoverageAction> = {};
  if (typeof policy.native === "string") {
    nativeDefault = action(policy.native, "allow", "native");
  } else if (policy.native && typeof policy.native === "object") {
    nativePaths = {};
    for (const [key, value] of Object.entries(policy.native)) {
      nativePaths[key] = action(value, "allow", `native.${key}`);
    }
  }

  let toolSchema: Required<ToolSchemaCoverage>;
  if (typeof policy.tool_schema === "string") {
    const a = action(policy.tool_schema, "redact", "tool_schema");
    toolSchema = { structural: "allow", text: a, valueBearing: "reject" };
  } else {
    const ts = policy.tool_schema ?? {};
    toolSchema = {
      structural: action(ts.structural, "allow", "tool_schema.structural"),
      text: action(ts.text, "redact", "tool_schema.text"),
      valueBearing: action(ts.valueBearing, "reject", "tool_schema.valueBearing"),
    };
  }

  return {
    system: action(policy.system, "redact", "system"),
    message_text: action(policy.message_text, "redact", "message_text"),
    tool_result: action(policy.tool_result, "redact", "tool_result"),
    tool_arguments: action(policy.tool_arguments, "redact", "tool_arguments"),
    tool_description: action(policy.tool_description, "redact", "tool_description"),
    reasoning: action(policy.reasoning, "reject", "reasoning"),
    toolSchema,
    extensionsDefault,
    extensionPaths,
    nativeDefault,
    nativePaths,
  };
}

export function extensionAction(
  coverage: NormalizedCoverage,
  path: string,
): CoverageAction {
  if (path in coverage.extensionPaths) return coverage.extensionPaths[path];
  return coverage.extensionsDefault;
}

/** Resolve a native partition field action; key is `<proto>.<field>`. */
export function nativeAction(
  coverage: NormalizedCoverage,
  path: string,
): CoverageAction {
  if (path in coverage.nativePaths) return coverage.nativePaths[path];
  return coverage.nativeDefault;
}

/** Channels that are only ever `redact` / `allow` / `reject` at the top level. */
export function isSimpleRedactChannel(channel: PrivacyChannel): boolean {
  return (
    channel === "system" ||
    channel === "message_text" ||
    channel === "tool_result" ||
    channel === "tool_arguments" ||
    channel === "tool_description"
  );
}
