/**
 * Cross-protocol native-field projection (docs/07 §5.6 DEC-17, §6.2).
 *
 * When a codec targets a protocol, the *other* protocol's native partition
 * cannot be rendered (no implicit cross-partition use). Each present field is
 * adjudicated by the source protocol's policy table: droppable -> recorded
 * drop; required -> fail-closed.
 */
import type { FieldPolicy } from "../policy/policy.js";
import {
  ANTHROPIC_REQUEST_POLICY,
  ANTHROPIC_TOOL_POLICY,
  CHAT_REQUEST_POLICY,
} from "../policy/request.js";
import type {
  AnthropicNativeRequest,
  AnthropicNativeTool,
  ChatNativeRequest,
} from "../native/index.js";
import { applyFieldPolicy, type ProjectionSink } from "./apply.js";
import type { PolicyOverride } from "./override.js";

const UNSUPPORTED_BY_TARGET = {
  kind: "unsupported",
  cause: "unsupported_by_target",
} as const;

/**
 * Native fields that only describe the *wire form* of a value the IR already
 * carries (`max_tokens` vs `max_completion_tokens`). A target protocol has a
 * single form, so targeting it is a lossless transform, not a drop (§6.2.1).
 */
const CHAT_LOSSLESS_FORM_HINTS: ReadonlySet<string> = new Set(["maxTokensField"]);

function project(
  sink: ProjectionSink,
  partition: "anthropic" | "chat",
  native: Record<string, unknown> | undefined,
  policy: Record<string, FieldPolicy>,
  overrides?: readonly PolicyOverride[],
  lossless: ReadonlySet<string> = new Set(),
): void {
  if (!native) return;
  for (const [key, fieldPolicy] of Object.entries(policy)) {
    const value = native[key];
    if (value === undefined) continue;
    applyFieldPolicy(
      sink,
      `native.${partition}.${key}`,
      value,
      fieldPolicy,
      lossless.has(key) ? { kind: "transformed" } : UNSUPPORTED_BY_TARGET,
      overrides,
    );
  }
}

export function projectAnthropicRequest(
  sink: ProjectionSink,
  native?: AnthropicNativeRequest,
  overrides?: readonly PolicyOverride[],
): void {
  project(
    sink,
    "anthropic",
    native as Record<string, unknown> | undefined,
    ANTHROPIC_REQUEST_POLICY as unknown as Record<string, FieldPolicy>,
    overrides,
  );
}

export function projectChatRequest(
  sink: ProjectionSink,
  native?: ChatNativeRequest,
  overrides?: readonly PolicyOverride[],
): void {
  project(
    sink,
    "chat",
    native as Record<string, unknown> | undefined,
    CHAT_REQUEST_POLICY as unknown as Record<string, FieldPolicy>,
    overrides,
    CHAT_LOSSLESS_FORM_HINTS,
  );
}

/**
 * Anthropic tool-definition native fields when targeting another protocol.
 *
 * `cacheControl` is deliberately not adjudicated here: a tool breakpoint is
 * already reported as a LOSSY `privacy_cache_control_dropped` warning by the
 * Chat codec, so admitting it again would double-report.
 */
export function projectAnthropicTool(
  sink: ProjectionSink,
  native: AnthropicNativeTool | undefined,
  pathPrefix: string,
  overrides?: readonly PolicyOverride[],
): void {
  if (!native) return;
  const fields: Record<string, FieldPolicy> = {
    type: ANTHROPIC_TOOL_POLICY.type,
    extra: ANTHROPIC_TOOL_POLICY.extra,
  };
  for (const [key, policy] of Object.entries(fields)) {
    const value = (native as Record<string, unknown>)[key];
    if (value === undefined) continue;
    applyFieldPolicy(
      sink,
      `${pathPrefix}.native.anthropic.${key}`,
      value,
      policy,
      UNSUPPORTED_BY_TARGET,
      overrides,
    );
  }
}
