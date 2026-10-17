/**
 * Anthropic Messages request codec (FR-004, FR-002).
 */
import type {
  CanonicalGenerationOptions,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalThinkingConfig,
  CanonicalTool,
  CanonicalToolChoice,
  ContentPart,
} from "../../ir/types.js";
import { validationError } from "../../errors.js";
import type { CodecContext, RequestCodec } from "../protocol-adapter.js";
import {
  parseAnthropicContent,
  renderAnthropicContent,
  safeParseJson,
} from "./content.js";
import { normalizeAnthropicTurns } from "./normalize.js";
import { isEphemeralCacheControl } from "../../cache/anthropic/cache-control.js";
import { getCacheControl } from "../../ir/native/accessors.js";
import { recordExtensionDisposition } from "../extension-evidence.js";
import type { AnthropicNativeRequest, AnthropicNativeTool } from "../../ir/native/index.js";
import type { ProviderProfile, RoleCapabilities } from "../../capabilities/provider-profile.js";
import { roleProjectionError } from "../../ir/projection/role.js";
import { projectChatRequest } from "../../ir/projection/native.js";
import { applyFieldPolicy } from "../../ir/projection/apply.js";

/** Anthropic requires an explicit max_tokens; OpenAI Chat does not. */
const DEFAULT_MAX_TOKENS = 1024;

const KNOWN_FIELDS = [
  "model",
  "max_tokens",
  "stream",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "metadata",
  "thinking",
  "output_config",
  "service_tier",
];

function parseSystemMessages(system: unknown, ctx: CodecContext): CanonicalMessage[] {
  if (system === undefined) return [];
  const parts = parseAnthropicContent(system, ctx);
  if (!parts.length) return [];
  return [
    {
      role: "system",
      content: parts,
      native: { anthropic: { origin: "top_level_system" } },
    },
  ];
}

function parseMessages(
  messages: unknown,
  ctx: CodecContext,
): CanonicalMessage[] {
  if (!Array.isArray(messages)) throw validationError("messages must be an array");
  return messages.map((m, i) => {
    if (!m || typeof m !== "object") {
      throw validationError(`messages[${i}] must be an object`);
    }
    const role = (m as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") {
      throw validationError(`messages[${i}] has an unsupported role`);
    }
    return {
      role,
      content: parseAnthropicContent((m as { content?: unknown }).content ?? "", ctx),
    };
  });
}

/** Tool-definition fields the canonical IR already owns. */
const TOOL_IR_FIELDS = new Set(["name", "description", "input_schema", "type", "cache_control"]);

function parseTools(tools: unknown, ctx: CodecContext): CanonicalTool[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw validationError("tools must be an array");
  return tools.map((t, i) => {
    if (!t || typeof t !== "object") throw validationError(`tools[${i}] must be an object`);
    const tool = t as Record<string, unknown>;
    if (typeof tool.name !== "string") {
      throw validationError(`tools[${i}] requires a string name`);
    }
    if (tool.input_schema !== undefined && typeof tool.input_schema !== "object") {
      throw validationError(`tools[${i}].input_schema must be an object`);
    }
    if (tool.type !== undefined && (typeof tool.type !== "string" || tool.type === "")) {
      throw validationError(`tools[${i}].type must be a non-empty string`);
    }
    // `custom` is Anthropic's implicit default, so it is normalized away; any
    // other `type` is a server tool whose parameter shape the provider owns.
    const serverToolType = typeof tool.type === "string" && tool.type !== "custom" ? tool.type : undefined;
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(tool)) {
      if (TOOL_IR_FIELDS.has(key)) continue;
      extra[key] = value;
    }
    // A server tool declares no JSON schema; keep its residue (if any) verbatim.
    if (serverToolType && tool.input_schema !== undefined) extra.input_schema = tool.input_schema;
    const cacheControl = isEphemeralCacheControl(tool.cache_control)
      ? (tool.cache_control as { type: "ephemeral"; ttl?: string })
      : undefined;
    const nativeAnthropic: AnthropicNativeTool = {
      ...(serverToolType ? { type: serverToolType } : {}),
      ...(cacheControl ? { cacheControl } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
    return {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: serverToolType ? {} : ((tool.input_schema as Record<string, unknown>) ?? {}),
      ...(Object.keys(nativeAnthropic).length ? { native: { anthropic: nativeAnthropic } } : {}),
    };
  });
}

function parseToolChoice(choice: unknown, ctx: CodecContext): CanonicalToolChoice | undefined {
  if (choice === undefined) return undefined;
  const c = choice as { type?: unknown; name?: unknown };
  switch (c.type) {
    case "auto":
      return { type: "auto" };
    case "none":
      return { type: "none" };
    case "any":
      return { type: "required" };
    case "tool":
      if (typeof c.name !== "string") throw validationError("tool_choice.tool requires a name");
      return { type: "tool", name: c.name };
    default:
      throw validationError("unsupported tool_choice type");
  }
}

/** Anthropic `tool_choice.disable_parallel_tool_use` -> parallelToolCalls=false. */
function parseDisableParallel(choice: unknown): boolean | undefined {
  if (!choice || typeof choice !== "object") return undefined;
  const c = choice as { disable_parallel_tool_use?: unknown };
  if (c.disable_parallel_tool_use === true) return false;
  return undefined;
}

function parseThinking(
  thinking: unknown,
  outputConfig: unknown,
): CanonicalThinkingConfig | undefined {
  if (thinking === undefined) return undefined;
  const t = thinking as { type?: unknown; budget_tokens?: unknown };
  switch (t.type) {
    case "disabled":
      return { mode: "disabled" };
    case "enabled":
      return {
        mode: "enabled",
        budgetTokens: typeof t.budget_tokens === "number" ? t.budget_tokens : undefined,
      };
    case "adaptive": {
      const effort = parseEffort(
        (outputConfig as { effort?: unknown } | undefined)?.effort,
      );
      return { mode: "adaptive", effort };
    }
    default:
      throw validationError("unsupported thinking type");
  }
}

export function createAnthropicRequestCodec(profile: ProviderProfile): RequestCodec {
  const roles = profile.capabilities.roles;
  return {
  supportsExtensionReport: true,

  detectStreaming(payload: unknown): boolean {
    const p = payload as { stream?: unknown };
    return p?.stream === true;
  },

  parseRequest(payload: unknown, ctx: CodecContext = { warnings: [] }): CanonicalRequest {
    if (!payload || typeof payload !== "object") {
      throw validationError("request body must be a JSON object");
    }
    const p = payload as Record<string, unknown>;
    if (typeof p.model !== "string") throw validationError("model is required");
    if (p.messages === undefined) throw validationError("messages is required");

    const extensions: Record<string, unknown> = {};
    for (const key of Object.keys(p)) {
      if (!KNOWN_FIELDS.includes(key)) extensions[key] = p[key];
    }

    const generation: CanonicalGenerationOptions = {};
    if (typeof p.max_tokens === "number") generation.maxTokens = p.max_tokens;
    if (typeof p.temperature === "number") generation.temperature = p.temperature;
    if (typeof p.top_p === "number") generation.topP = p.top_p;
    if (Array.isArray(p.stop_sequences)) {
      generation.stopSequences = p.stop_sequences.filter(
        (s): s is string => typeof s === "string",
      );
    }

    const anthropicNative: AnthropicNativeRequest = {};
    if (typeof p.top_k === "number") anthropicNative.topK = p.top_k;
    if (p.metadata !== undefined) {
      anthropicNative.metadata = p.metadata as Record<string, unknown>;
    }
    if (typeof p.service_tier === "string") anthropicNative.serviceTier = p.service_tier;
    if (p.output_config && typeof p.output_config === "object") {
      const rest = { ...(p.output_config as Record<string, unknown>) };
      delete rest.effort;
      if (Object.keys(rest).length) anthropicNative.outputConfig = rest;
    }

    return {
      model: p.model,
      messages: [
        ...parseSystemMessages(p.system, ctx),
        ...parseMessages(p.messages, ctx),
      ],
      tools: parseTools(p.tools, ctx),
      toolChoice: parseToolChoice(p.tool_choice, ctx),
      parallelToolCalls: parseDisableParallel(p.tool_choice),
      generation,
      thinking: parseThinking(p.thinking, p.output_config),
      ...(Object.keys(anthropicNative).length ? { native: { anthropic: anthropicNative } } : {}),
      extensions,
    };
  },

  renderRequest(
    canonical: CanonicalRequest,
    streaming: boolean,
    ctx: CodecContext = { warnings: [] },
  ): unknown {
    projectChatRequest(ctx, canonical.native?.chat);
    const body: Record<string, unknown> = {
      model: canonical.model,
      stream: streaming,
      max_tokens: canonical.generation?.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (canonical.generation?.maxTokens === undefined) {
      ctx.warnings.push({
        code: "default_max_tokens",
        message: `Generated default max_tokens=${DEFAULT_MAX_TOKENS} for Anthropic target`,
        fidelity: "COMPATIBLE",
        field: "generation.maxTokens",
      });
    }

    const { system, rest } = splitLeadingSystem(canonical.messages);
    if (system.length) {
      body.system = simplifyTextBlocks(renderAnthropicContent(system));
    }
    // Anthropic requires well-formed turns (tool_result placement, no runs of
    // adjacent same-role turns); normalize before rendering (P0-7).
    const messages = normalizeAnthropicTurns(rest, ctx);
    if (messages.length) {
      body.messages = messages.map((m) => renderMessage(m, ctx, roles));
    }
    if (canonical.tools?.length) {
      body.tools = canonical.tools.map((t, ti) => {
        if (t.strict !== undefined) {
          // Anthropic has no `strict`; droppable per CHAT_TOOL_POLICY.
          applyFieldPolicy(ctx, `tools[${ti}].strict`, t.strict, "droppable", {
            kind: "unsupported",
            cause: "unsupported_by_target",
          });
        }
        const nativeAnthropic = t.native?.anthropic;
        const cacheControl = getCacheControl(t);
        const extra = nativeAnthropic?.extra;
        if (extra !== undefined) {
          recordExtensionDisposition(
            ctx,
            "extra",
            extra,
            true,
            `tools[${ti}].native.anthropic.extra`,
          );
        }
        if (nativeAnthropic?.type !== undefined) {
          // Server tool: the provider owns the parameter shape, so emit it
          // verbatim and never synthesize an `input_schema`.
          recordExtensionDisposition(
            ctx,
            "type",
            nativeAnthropic.type,
            true,
            `tools[${ti}].native.anthropic.type`,
          );
          return {
            type: nativeAnthropic.type,
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            ...extra,
            ...(cacheControl ? { cache_control: cacheControl } : {}),
          };
        }
        return {
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          input_schema: t.inputSchema,
          ...extra,
          ...(cacheControl ? { cache_control: cacheControl } : {}),
        };
      });
    }
    if (canonical.toolChoice) {
      const rendered = renderToolChoice(canonical.toolChoice);
      if (canonical.parallelToolCalls === false) {
        rendered.disable_parallel_tool_use = true;
      }
      body.tool_choice = rendered;
    } else if (canonical.parallelToolCalls === false) {
      // disable_parallel_tool_use is only expressible inside tool_choice.
      body.tool_choice = {
        type: "auto",
        disable_parallel_tool_use: true,
      };
      ctx.warnings.push({
        code: "parallel_tools_downgraded",
        message:
          "parallel_tool_calls=false represented as tool_choice.disable_parallel_tool_use=true",
        fidelity: "COMPATIBLE",
        field: "tool_choice.disable_parallel_tool_use",
      });
    }

    const gen = canonical.generation;
    if (gen?.temperature !== undefined) body.temperature = gen.temperature;
    if (gen?.topP !== undefined) body.top_p = gen.topP;
    if (gen?.stopSequences?.length) body.stop_sequences = gen.stopSequences;

    const nativeAnthropic = canonical.native?.anthropic;
    if (nativeAnthropic?.topK !== undefined) {
      body.top_k = nativeAnthropic.topK;
      recordExtensionDisposition(ctx, "topK", nativeAnthropic.topK, true, "native.anthropic.topK");
    }
    if (nativeAnthropic?.metadata !== undefined) {
      body.metadata = nativeAnthropic.metadata;
      recordExtensionDisposition(
        ctx,
        "metadata",
        nativeAnthropic.metadata,
        true,
        "native.anthropic.metadata",
      );
    }
    if (nativeAnthropic?.serviceTier !== undefined) {
      body.service_tier = nativeAnthropic.serviceTier;
      recordExtensionDisposition(
        ctx,
        "serviceTier",
        nativeAnthropic.serviceTier,
        true,
        "native.anthropic.serviceTier",
      );
    }

    // Extensions are legacy IR; unknown fields now live in the native
    // partitions (governed by the policy table). Any residual extension is
    // droppable and recorded as a drop, never a fidelity warning.
    for (const key of Object.keys(canonical.extensions ?? {})) {
      const value = (canonical.extensions ?? {})[key];
      applyFieldPolicy(ctx, `extensions.${key}`, value, "droppable", {
        kind: "unsupported",
        cause: "unsupported_by_target",
      });
      recordExtensionDisposition(ctx, key, value, false);
    }

    if (canonical.thinking) {
      const t = canonical.thinking;
      if (t.mode === "disabled") {
        body.thinking = { type: "disabled" };
      } else if (t.mode === "enabled") {
        body.thinking = {
          type: "enabled",
          ...(t.budgetTokens !== undefined ? { budget_tokens: t.budgetTokens } : {}),
        };
      } else if (t.mode === "adaptive") {
        body.thinking = { type: "adaptive" };
      }
    }

    const nativeOutputConfig = canonical.native?.anthropic?.outputConfig;
    const effort =
      canonical.thinking?.mode === "adaptive" ? canonical.thinking.effort : undefined;
    if (nativeOutputConfig || effort !== undefined) {
      body.output_config = {
        ...(nativeOutputConfig ?? {}),
        ...(effort !== undefined ? { effort } : {}),
      };
      if (nativeOutputConfig) {
        recordExtensionDisposition(
          ctx,
          "outputConfig",
          nativeOutputConfig,
          true,
          "native.anthropic.outputConfig",
        );
      }
    }

    return body;
  },
  };
}

function renderMessage(
  m: CanonicalMessage,
  ctx: CodecContext,
  roles: RoleCapabilities | undefined,
): unknown {
  if (m.role === "developer") {
    if (roles?.developerRole) {
      return { role: "developer", content: renderAnthropicContent(m.content) };
    }
    throw roleProjectionError("developer", "anthropic-messages");
  }
  if (m.role === "system") {
    if (roles?.midConversationSystem) {
      return { role: "system", content: renderAnthropicContent(m.content) };
    }
    throw roleProjectionError("system", "anthropic-messages");
  }
  const role = m.role === "tool" ? "user" : m.role;
  const blocks = renderAnthropicContent(m.content);
  return {
    role,
    content: m.role === "assistant" ? blocks : simplifyUserContent(blocks),
  };
}

/** Split leading contiguous system/developer messages into the top-level system block. */
function splitLeadingSystem(messages: CanonicalMessage[]): {
  system: ContentPart[];
  rest: CanonicalMessage[];
} {
  let i = 0;
  const system: ContentPart[] = [];
  while (i < messages.length && messages[i].role === "system") {
    system.push(...messages[i].content);
    i++;
  }
  return { system, rest: messages.slice(i) };
}

/** Single-text content renders as a plain string (Anthropic allows it). */
function simplifyTextBlocks(blocks: unknown[]): unknown {
  if (blocks.length === 1) {
    const b = blocks[0] as { type?: string; text?: string; cache_control?: unknown } | undefined;
    if (b?.type === "text" && b.text !== undefined && b.cache_control === undefined) {
      return b.text;
    }
  }
  return blocks;
}

/** Single-text user content renders as a plain string (Anthropic allows it). */
function simplifyUserContent(blocks: unknown[]): unknown {
  return simplifyTextBlocks(blocks);
}

function renderToolChoice(choice: CanonicalToolChoice): Record<string, unknown> {
  switch (choice.type) {
    case "auto":
      return { type: "auto" };
    case "none":
      return { type: "none" };
    case "required":
      return { type: "any" };
    case "tool":
      return { type: "tool", name: choice.name };
  }
}

const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
type ReasoningEffort = (typeof EFFORT_VALUES)[number];

function parseEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value === "string" && (EFFORT_VALUES as readonly string[]).includes(value)) {
    return value as ReasoningEffort;
  }
  return undefined;
}

export { DEFAULT_MAX_TOKENS };
