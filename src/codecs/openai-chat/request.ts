/**
 * OpenAI Chat Completions request codec (FR-004, FR-002).
 */
import type {
  CanonicalGenerationOptions,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
  CanonicalToolChoice,
  ContentPart,
} from "../../ir/types.js";
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import { unsupportedError, validationError } from "../../errors.js";
import type { CodecContext, RequestCodec } from "../protocol-adapter.js";
import type { TranslationPolicies } from "../../ir/policies.js";
import { DEFAULT_POLICIES } from "../../ir/policies.js";
import { recordExtensionDisposition } from "../extension-evidence.js";
import { getCacheControl } from "../../ir/native/accessors.js";
import type { RoleCapabilities } from "../../capabilities/provider-profile.js";
import type { ChatNativeRequest } from "../../ir/native/index.js";
import { roleProjectionError, fieldProjectionError } from "../../ir/projection/role.js";
import { assertToolPairing } from "../../ir/projection/tool.js";
import { projectAnthropicRequest, projectAnthropicTool } from "../../ir/projection/native.js";
import { applyFieldPolicy } from "../../ir/projection/apply.js";

const IR_MAPPED_FIELDS = [
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "reasoning_effort",
];

/**
 * Known OpenAI fields with no Canonical-IR home. They are preserved in
 * `extensions` on parse and rendered back verbatim, so nothing is silently
 * dropped (GAP-004 / 02.tech-v2.md 9.2 rule: mapped, preserved, or dropped+warned).
 */
const EXTENSION_FIELDS = [
  "stream_options",
  "store",
  "metadata",
  "user",
  "n",
  "logprobs",
  "top_logprobs",
  "response_format",
  "service_tier",
  "modalities",
  "audio",
];

const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
type ReasoningEffort = (typeof EFFORT_VALUES)[number];

/**
 * Anthropic 私有计费标记（Claude Code 注入的 `x-anthropic-billing-header`）。
 * OpenAI Chat 目标端不理解它，渲染时丢弃并警告，避免污染 system 前缀和
 * 计入 OpenAI token 计费（无静默降级）。
 */
const ANTHROPIC_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

function parseEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value === "string" && (EFFORT_VALUES as readonly string[]).includes(value)) {
    return value as ReasoningEffort;
  }
  return undefined;
}

export function createOpenAiChatRequestCodec(
  profile: ProviderProfile,
  policies: TranslationPolicies = DEFAULT_POLICIES,
): RequestCodec {
  const reasoningField = profile.capabilities.reasoningField;

  return {
    supportsExtensionReport: true,

    detectStreaming(payload: unknown): boolean {
      const p = payload as { stream?: unknown };
      return p?.stream === true;
    },

    parseRequest(
      payload: unknown,
      ctx: CodecContext = { warnings: [] },
    ): CanonicalRequest {
      if (!payload || typeof payload !== "object") {
        throw validationError("request body must be a JSON object");
      }
      const p = payload as Record<string, unknown>;
      if (typeof p.model !== "string") throw validationError("model is required");

      const signatureField = profile.capabilities.reasoning?.signatureField;
      const messages = parseMessages(
        p.messages,
        reasoningField,
        ctx,
        signatureField,
      );
      const effort = parseEffort(p.reasoning_effort);

      // `stream_options.include_usage` is the IR `includeUsage` hint; other
      // stream_options keys are protocol-native (Presence/shape preserved).
      let includeUsage: boolean | undefined;
      let streamOptions: Record<string, unknown> | undefined;
      if (p.stream_options && typeof p.stream_options === "object") {
        const so = { ...(p.stream_options as Record<string, unknown>) };
        if (typeof so.include_usage === "boolean") includeUsage = so.include_usage;
        delete so.include_usage;
        if (Object.keys(so).length) streamOptions = so;
      }

      const nativeChat: ChatNativeRequest = {};
      if (typeof p.max_completion_tokens === "number") {
        nativeChat.maxTokensField = "max_completion_tokens";
      } else if (typeof p.max_tokens === "number") {
        nativeChat.maxTokensField = "max_tokens";
      }
      if (streamOptions) nativeChat.streamOptions = streamOptions;
      if (typeof p.store === "boolean") nativeChat.store = p.store;
      if (p.metadata && typeof p.metadata === "object") {
        nativeChat.metadata = p.metadata as Record<string, unknown>;
      }
      if (typeof p.user === "string") nativeChat.user = p.user;
      if (typeof p.n === "number") nativeChat.n = p.n;
      if (typeof p.logprobs === "boolean") nativeChat.logprobs = p.logprobs;
      if (typeof p.top_logprobs === "number") nativeChat.topLogprobs = p.top_logprobs;
      if (p.response_format && typeof p.response_format === "object") {
        nativeChat.responseFormat = p.response_format as Record<string, unknown>;
      }
      if (typeof p.service_tier === "string") nativeChat.serviceTier = p.service_tier;
      if (Array.isArray(p.modalities)) {
        nativeChat.modalities = p.modalities.filter((m): m is string => typeof m === "string");
      }
      if (p.audio && typeof p.audio === "object") {
        nativeChat.audio = p.audio as Record<string, unknown>;
      }
      if (effort === undefined && typeof p.reasoning_effort === "string") {
        nativeChat.reasoningEffort = p.reasoning_effort;
      }

      // Residual unknown fields: same-protocol preserve in `native.chat.extra`
      // (docs/07 §5.9); a target that cannot express them fails closed.
      const knownFields = new Set([...IR_MAPPED_FIELDS, ...EXTENSION_FIELDS]);
      for (const key of Object.keys(p)) {
        if (knownFields.has(key)) continue;
        (nativeChat.extra ??= {})[key] = p[key];
      }

      const generation: CanonicalGenerationOptions = {};
      if (typeof p.max_completion_tokens === "number") {
        generation.maxTokens = p.max_completion_tokens;
      } else if (typeof p.max_tokens === "number") {
        generation.maxTokens = p.max_tokens;
      }
      if (typeof p.temperature === "number") generation.temperature = p.temperature;
      if (typeof p.top_p === "number") generation.topP = p.top_p;
      if (typeof p.stop === "string") {
        generation.stopSequences = [p.stop];
      } else if (Array.isArray(p.stop)) {
        generation.stopSequences = p.stop.filter((s): s is string => typeof s === "string");
      }
      if (typeof p.presence_penalty === "number") {
        generation.presencePenalty = p.presence_penalty;
      }
      if (typeof p.frequency_penalty === "number") {
        generation.frequencyPenalty = p.frequency_penalty;
      }
      if (typeof p.seed === "number") generation.seed = p.seed;

      const parallelToolCalls =
        typeof p.parallel_tool_calls === "boolean" ? p.parallel_tool_calls : undefined;

      const thinking =
        effort !== undefined
          ? { mode: "adaptive" as const, effort }
          : undefined;

      return {
        model: p.model,
        messages,
        tools: parseTools(p.tools),
        toolChoice: parseToolChoice(p.tool_choice),
        generation,
        thinking,
        parallelToolCalls,
        includeUsage,
        ...(Object.keys(nativeChat).length ? { native: { chat: nativeChat } } : {}),
      };
    },

    renderRequest(
      canonical: CanonicalRequest,
      streaming: boolean,
      ctx: CodecContext = { warnings: [] },
    ): unknown {
      projectAnthropicRequest(ctx, canonical.native?.anthropic);
      const body: Record<string, unknown> = {
        model: canonical.model,
        stream: streaming,
        messages: renderMessages(
          canonical,
          reasoningField,
          ctx,
          profile.capabilities.reasoning?.signatureField,
          profile.capabilities.roles,
        ),
      };
      warnDroppedCacheControl(canonical, ctx);
      if (canonical.tools?.length) {
        body.tools = canonical.tools.map((t, ti) => {
          // Anthropic server tools have no Chat equivalent; adjudicate before
          // the map so they fail closed instead of becoming empty functions.
          projectAnthropicTool(ctx, t.native?.anthropic, `tools[${ti}]`);
          return {
            type: "function",
            function: {
              name: t.name,
              ...(t.description !== undefined ? { description: t.description } : {}),
              parameters: t.inputSchema,
              ...(t.strict !== undefined ? { strict: t.strict } : {}),
            },
          };
        });
      }
      if (canonical.toolChoice) body.tool_choice = renderToolChoice(canonical.toolChoice);
      if (canonical.parallelToolCalls !== undefined) {
        body.parallel_tool_calls = canonical.parallelToolCalls;
      }

      const nativeChat = canonical.native?.chat;
      // reasoning_effort is native to OpenAI Chat; render it from the canonical
      // thinking config regardless of the declared capability gate.
      if (canonical.thinking?.effort !== undefined) {
        body.reasoning_effort = canonical.thinking.effort;
      } else if (nativeChat?.reasoningEffort !== undefined) {
        body.reasoning_effort = nativeChat.reasoningEffort;
      }

      const gen = canonical.generation;
      if (gen?.maxTokens !== undefined) {
        if (nativeChat?.maxTokensField === "max_completion_tokens") {
          body.max_completion_tokens = gen.maxTokens;
        } else {
          body.max_tokens = gen.maxTokens;
        }
      }
      if (gen?.temperature !== undefined) body.temperature = gen.temperature;
      if (gen?.topP !== undefined) body.top_p = gen.topP;
      if (gen?.stopSequences?.length) body.stop = gen.stopSequences;
      if (gen?.presencePenalty !== undefined) body.presence_penalty = gen.presencePenalty;
      if (gen?.frequencyPenalty !== undefined) body.frequency_penalty = gen.frequencyPenalty;
      if (gen?.seed !== undefined) body.seed = gen.seed;

      if (nativeChat) {
        if (nativeChat.store !== undefined) body.store = nativeChat.store;
        if (nativeChat.metadata !== undefined) body.metadata = nativeChat.metadata;
        if (nativeChat.user !== undefined) body.user = nativeChat.user;
        if (nativeChat.n !== undefined) body.n = nativeChat.n;
        if (nativeChat.logprobs !== undefined) body.logprobs = nativeChat.logprobs;
        if (nativeChat.topLogprobs !== undefined) body.top_logprobs = nativeChat.topLogprobs;
        if (nativeChat.responseFormat !== undefined) {
          body.response_format = nativeChat.responseFormat;
        }
        if (nativeChat.serviceTier !== undefined) body.service_tier = nativeChat.serviceTier;
        if (nativeChat.modalities !== undefined) body.modalities = nativeChat.modalities;
        if (nativeChat.audio !== undefined) body.audio = nativeChat.audio;
        if (nativeChat.streamOptions !== undefined) {
          body.stream_options = { ...nativeChat.streamOptions };
        }
        for (const [key, value] of Object.entries(nativeChat)) {
          if (key === "maxTokensField" || key === "extra") continue;
          recordExtensionDisposition(ctx, key, value, true, `native.chat.${key}`);
        }
        if (nativeChat.extra) {
          for (const [key, value] of Object.entries(nativeChat.extra)) {
            body[key] = value;
            recordExtensionDisposition(ctx, key, value, true, `native.chat.extra.${key}`);
          }
        }
      }

      // includeUsage is best-effort: only OpenAI Chat streaming carries it.
      // `false` removes any inherited flag; unsupported shapes are ignored.
      if (canonical.includeUsage !== undefined && streaming) {
        const streamOptions = {
          ...((body.stream_options as Record<string, unknown> | undefined) ?? {}),
        };
        if (canonical.includeUsage) streamOptions.include_usage = true;
        else delete streamOptions.include_usage;
        if (Object.keys(streamOptions).length) body.stream_options = streamOptions;
        else delete body.stream_options;
      }

      // Residual extensions (externally constructed IR) are droppable and
      // recorded as drops, not fidelity warnings.
      const ext = canonical.extensions ?? {};
      for (const key of Object.keys(ext)) {
        applyFieldPolicy(ctx, `extensions.${key}`, ext[key], "droppable", {
          kind: "unsupported",
          cause: "unsupported_by_target",
        });
        recordExtensionDisposition(ctx, key, ext[key], false);
      }

      // TH-004: never silently drop a thinking configuration request. Only
      // budget/adaptive requests OpenAI Chat cannot express trigger the policy;
      // a bare `effort` is rendered natively as reasoning_effort above.
      const thinking = canonical.thinking;
      const thinkingNeedsPolicy =
        thinking !== undefined && thinking.mode === "enabled" && !profile.capabilities.thinking;
      if (thinkingNeedsPolicy) {
        switch (policies.reasoning) {
          case "reject":
            throw unsupportedError(
              "Thinking configuration requested but the OpenAI Chat target does not declare thinking capability; rejected by policy",
            );
          case "provider_metadata": {
            const meta = (body.metadata as Record<string, unknown> | undefined) ?? {};
            meta.llm_protocol_thinking = {
              mode: thinking.mode,
              budgetTokens: thinking.budgetTokens,
            };
            body.metadata = meta;
            ctx.warnings.push({
              code: "thinking_provider_metadata",
              message: "Thinking configuration preserved as request metadata per provider_metadata policy",
              fidelity: "COMPATIBLE",
              field: "thinking",
            });
            break;
          }
          case "drop_with_warning":
          default:
            ctx.warnings.push({
              code: "thinking_dropped",
              message:
                "Thinking configuration requested but target profile does not declare thinking capability; dropped with warning",
              fidelity: "LOSSY",
              field: "thinking",
            });
        }
      }

      return body;
    },
  };
}

function parseMessages(
  raw: unknown,
  reasoningField: string | undefined,
  ctx: CodecContext,
  signatureField?: string,
): CanonicalMessage[] {  if (!Array.isArray(raw)) throw validationError("messages must be an array");
  const messages: CanonicalMessage[] = [];

  for (let i = 0; i < raw.length; i++) {
    const m = raw[i] as Record<string, unknown> | null | undefined;
    if (!m || typeof m !== "object") {
      throw validationError(`messages[${i}] must be an object`);
    }
    const role = m.role;
    if (role === "system" || role === "developer") {
      messages.push({
        role,
        content: parseUserParts(m.content, ctx),
        native: { chat: { origin: "messages" } },
      });
    } else if (role === "user") {
      messages.push({ role: "user", content: parseUserParts(m.content, ctx) });
    } else if (role === "assistant") {
      messages.push({
        role: "assistant",
        content: parseAssistantParts(m, reasoningField, ctx, signatureField),
      });
    } else if (role === "tool") {
      if (typeof m.tool_call_id !== "string") {
        throw validationError(`messages[${i}] tool message requires tool_call_id`);
      }
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: m.tool_call_id,
            content: parseUserParts(m.content, ctx),
          },
        ],
        native: { chat: { origin: "messages" } },
      });
    } else {
      ctx.warnings.push({
        code: "unknown_role",
        message: "Unknown OpenAI message role skipped",
        fidelity: "LOSSY",
        field: `messages[${i}].role`,
      });
    }
  }

  return messages;
}

function parseUserParts(content: unknown, ctx: CodecContext): ContentPart[] {
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) throw validationError("message content must be a string or array");
  const parts: ContentPart[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      throw validationError("content block must be an object");
    }
    const b = block as Record<string, unknown>;
    if (b.type === "text") {
      if (typeof b.text !== "string") throw validationError("text block requires a string text");
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image_url") {
      const url = (b.image_url as { url?: unknown } | undefined)?.url;
      if (typeof url !== "string") throw validationError("image_url block requires image_url.url");
      parts.push({ type: "image", source: { type: "url", url } });
    } else {
      ctx.warnings.push({
        code: "unknown_content_block",
        message: "Unknown OpenAI content block type skipped",
        fidelity: "LOSSY",
        field: "content",
      });
    }
  }
  return parts;
}

function parseAssistantParts(
  m: Record<string, unknown>,
  reasoningField: string | undefined,
  ctx: CodecContext,
  signatureField?: string,
): ContentPart[] {
  const parts: ContentPart[] = [];
  if (typeof m.content === "string" && m.content) {
    parts.push({ type: "text", text: m.content });
  }
  const reasoningText =
    reasoningField && typeof m[reasoningField] === "string" ? m[reasoningField] : undefined;
  const signature =
    signatureField && typeof m[signatureField] === "string" ? m[signatureField] : undefined;
  if (reasoningText || signature) {
    // Preserve the opaque thinking signature into IR so it can be restored on
    // the Anthropic side (P1-2). It is never parsed or rewritten.
    parts.push({
      type: "reasoning",
      ...(reasoningText ? { text: reasoningText as string } : {}),
      ...(signature ? { signature } : {}),
    });
  } else if (!reasoningField) {
    // TH-003: never guess the field name, but never silently drop reasoning
    // either. Surfacing a warning satisfies the no-silent-downgrade rule.
    const seen = Object.keys(m).filter((k) =>
      ["reasoning_content", "reasoning"].includes(k),
    );
    for (const key of seen) {
      if (typeof m[key] === "string" && m[key]) {
        ctx.warnings.push({
          code: "unmapped_reasoning",
          message: `Reasoning field "${key}" present but provider profile does not declare a reasoning field; not guessed`,
          fidelity: "LOSSY",
          field: `messages.assistant.${key}`,
        });
      }
    }
  }
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      const t = tc as {
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      if (t.function && typeof t.function.name === "string") {
        parts.push({
          type: "tool_call",
          id: typeof t.id === "string" ? t.id : `call_${parts.length}`,
          name: t.function.name,
          argumentsText: typeof t.function.arguments === "string" ? t.function.arguments : "{}",
        });
      }
    }
  }
  return parts;
}

function parseTools(tools: unknown): CanonicalTool[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw validationError("tools must be an array");
  return tools.map((t) => {
    const tool = t as {
      type?: unknown;
      function?: { name?: unknown; description?: unknown; parameters?: unknown; strict?: unknown };
    };
    const fn = tool.function;
    if (!fn || typeof fn.name !== "string") {
      throw validationError("tool requires function.name");
    }
    if (fn.parameters !== undefined && typeof fn.parameters !== "object") {
      throw validationError("tool parameters must be an object");
    }
    return {
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : undefined,
      inputSchema: (fn.parameters as Record<string, unknown>) ?? {},
      strict: fn.strict === true ? true : fn.strict === false ? false : undefined,
    };
  });
}

function parseToolChoice(choice: unknown): CanonicalToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "required" };
  if (typeof choice === "object" && choice !== null) {
    const c = choice as { type?: unknown; function?: { name?: unknown } };
    if (c.type === "function" && c.function && typeof c.function.name === "string") {
      return { type: "tool", name: c.function.name };
    }
  }
  throw validationError("unsupported tool_choice value");
}

function renderMessages(
  canonical: CanonicalRequest,
  reasoningField: string | undefined,
  ctx: CodecContext,
  signatureField?: string,
  roles?: RoleCapabilities,
): unknown[] {
  assertToolPairing(canonical.messages, "openai-chat");
  const out: unknown[] = [];
  for (const m of canonical.messages) {
    if (m.content.some((p) => p.type === "opaque_native")) {
      throw fieldProjectionError("opaque_native", "openai-chat");
    }
    if (m.role === "developer" && roles?.developerRole !== true) {
      throw roleProjectionError("developer", "openai-chat");
    }
    if (m.role === "system" || m.role === "developer") {
      const content = stripAnthropicBillingHeaders(m.content, ctx);
      if (content.length) {
        out.push({ role: m.role, content: renderUserContent(content, ctx) });
      }
      continue;
    }
    if (m.role === "assistant") {
      out.push(renderAssistantMessage(m, reasoningField, signatureField));
      continue;
    }
    // user or tool messages: split text parts and tool_result parts. OpenAI
    // requires the tool messages to IMMEDIATELY follow the assistant tool_calls
    // message (no user/system turn in between), so emit tool_result messages
    // first and push any same-turn text after them.
    const textParts = m.content.filter(
      (p) => p.type === "text" || p.type === "image",
    );
    const toolParts = m.content.filter((p) => p.type === "tool_result");
    const reasoningParts = m.content.filter((p) => p.type === "reasoning");
    for (const tp of toolParts) {
      out.push({
        role: "tool",
        tool_call_id: tp.toolCallId,
        content: renderUserContent(tp.content, ctx),
      });
    }
    if (textParts.length) {
      const rendered = renderUserContent(textParts, ctx);
      const isEmpty =
        (typeof rendered === "string" && rendered === "") ||
        (Array.isArray(rendered) && rendered.length === 0);
      if (!isEmpty) out.push({ role: "user", content: rendered });
    }
    if (reasoningParts.length && reasoningField) {
      out.push({
        role: "user",
        content: reasoningParts.map((r) => r.text ?? "").join(""),
      });
    }
  }
  return out;
}

/** Drop Anthropic billing-header text blocks from a system part list for the OpenAI target. */
function stripAnthropicBillingHeaders(
  parts: ContentPart[],
  ctx: CodecContext,
): ContentPart[] {
  return parts.filter((p) => {
    if (p.type === "text" && p.text.trimStart().toLowerCase().startsWith(ANTHROPIC_BILLING_HEADER_PREFIX)) {
      ctx.warnings.push({
        code: "anthropic_billing_header_dropped",
        message: "Anthropic billing header dropped for OpenAI Chat target",
        fidelity: "LOSSY",
        field: "system.content.text",
      });
      return false;
    }
    return true;
  });
}

function renderUserContent(parts: ContentPart[], ctx: CodecContext): string | unknown[] {
  const textOnly = parts.every((p) => p.type === "text");
  if (textOnly) {
    const joined = parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return joined;
  }
  return parts
    .map((p): unknown => {
      if (p.type === "text") return { type: "text", text: p.text };
      if (p.type === "image") {
        if (p.source.type === "url") {
          return { type: "image_url", image_url: { url: p.source.url } };
        }
        // OpenAI accepts base64 images as data URLs, so this is lossless.
        return {
          type: "image_url",
          image_url: { url: `data:${p.source.mediaType};base64,${p.source.data}` },
        };
      }
      return p;
    })
    .filter((b): b is unknown => b !== null);
}

function renderAssistantMessage(
  m: CanonicalMessage,
  reasoningField: string | undefined,
  signatureField?: string,
): unknown {
  const text = m.content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
  const calls = m.content.filter(
    (p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call",
  );
  const reasoning = m.content.filter(
    (p): p is Extract<ContentPart, { type: "reasoning" }> => p.type === "reasoning",
  );
  const msg: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
  };
  if (reasoningField && reasoning.length) {
    msg[reasoningField] = reasoning.map((r) => r.text ?? "").join("");
  }
  // Restore the opaque signature to the provider's declared field (P1-2).
  const signature = reasoning
    .map((r) => r.signature)
    .find((s): s is string => typeof s === "string");
  if (signature !== undefined && signatureField) {
    msg[signatureField] = signature;
  }
  if (calls.length) {
    msg.tool_calls = calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.argumentsText },
    }));
  }
  return msg;
}

/**
 * OpenAI Chat has no representable prompt-cache breakpoint; dropping an IR
 * `cache_control` is a fidelity loss and must be reported (PR-017, no silent
 * downgrade).
 */
function warnDroppedCacheControl(
  canonical: CanonicalRequest,
  ctx: CodecContext,
): void {
  let dropped = false;
  const scan = (parts: ContentPart[] | undefined): void => {
    for (const part of parts ?? []) {
      if (part.type === "text" && getCacheControl(part)) dropped = true;
      if (part.type === "tool_result") scan(part.content);
    }
  };
  for (const message of canonical.messages) scan(message.content);
  if (canonical.tools?.some((t) => getCacheControl(t))) dropped = true;
  if (dropped) {
    ctx.warnings.push({
      code: "privacy_cache_control_dropped",
      message: "Prompt-cache control is not representable in the OpenAI Chat target and was dropped",
      fidelity: "LOSSY",
      field: "cache",
    });
  }
}

function renderToolChoice(choice: CanonicalToolChoice): unknown {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "required":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
  }
}
