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
 * dropped (GAP-004 / tech-v2.md 9.2 rule: mapped, preserved, or dropped+warned).
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

interface ParsedMessages {
  system?: ContentPart[];
  messages: CanonicalMessage[];
}

export function createOpenAiChatRequestCodec(
  profile: ProviderProfile,
  policies: TranslationPolicies = DEFAULT_POLICIES,
): RequestCodec {
  const reasoningField = profile.capabilities.reasoningField;

  return {
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
      const { system, messages } = parseMessages(
        p.messages,
        reasoningField,
        ctx,
        signatureField,
      );
      const effort = parseEffort(p.reasoning_effort);
      const extensions: Record<string, unknown> = {};
      // Preserve every field that has no canonical home — either a known
      // extension field or a truly unknown field (GAP-004). An unmapped
      // `reasoning_effort` value is preserved rather than silently dropped.
      for (const key of Object.keys(p)) {
        if (!IR_MAPPED_FIELDS.includes(key)) extensions[key] = p[key];
        else if (key === "reasoning_effort" && effort === undefined) {
          extensions[key] = p[key];
        }
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
        system,
        tools: parseTools(p.tools),
        toolChoice: parseToolChoice(p.tool_choice),
        generation,
        thinking,
        parallelToolCalls,
        extensions,
      };
    },

    renderRequest(
      canonical: CanonicalRequest,
      streaming: boolean,
      ctx: CodecContext = { warnings: [] },
    ): unknown {
      const body: Record<string, unknown> = {
        model: canonical.model,
        stream: streaming,
        messages: renderMessages(
          canonical,
          reasoningField,
          ctx,
          profile.capabilities.reasoning?.signatureField,
        ),
      };
      if (canonical.tools?.length) {
        body.tools = canonical.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            parameters: t.inputSchema,
            ...(t.strict !== undefined ? { strict: t.strict } : {}),
          },
        }));
      }
      if (canonical.toolChoice) body.tool_choice = renderToolChoice(canonical.toolChoice);
      if (canonical.parallelToolCalls !== undefined) {
        body.parallel_tool_calls = canonical.parallelToolCalls;
      }

      // reasoning_effort is native to OpenAI Chat; render it from the canonical
      // thinking config regardless of the declared capability gate.
      if (canonical.thinking?.effort !== undefined) {
        body.reasoning_effort = canonical.thinking.effort;
      } else if (canonical.extensions?.reasoning_effort !== undefined) {
        // Unmapped effort value preserved through extensions (GAP-004).
        body.reasoning_effort = canonical.extensions.reasoning_effort;
      }

      const gen = canonical.generation;
      if (gen?.maxTokens !== undefined) body.max_tokens = gen.maxTokens;
      if (gen?.temperature !== undefined) body.temperature = gen.temperature;
      if (gen?.topP !== undefined) body.top_p = gen.topP;
      if (gen?.stopSequences?.length) body.stop = gen.stopSequences;
      if (gen?.presencePenalty !== undefined) body.presence_penalty = gen.presencePenalty;
      if (gen?.frequencyPenalty !== undefined) body.frequency_penalty = gen.frequencyPenalty;
      if (gen?.seed !== undefined) body.seed = gen.seed;

      const ext = canonical.extensions ?? {};
      for (const key of EXTENSION_FIELDS) {
        if (ext[key] !== undefined) body[key] = ext[key];
      }
      for (const key of Object.keys(ext)) {
        if (key === "reasoning_effort") continue; // handled explicitly above
        if (!EXTENSION_FIELDS.includes(key)) {
          ctx.warnings.push({
            code: "dropped_extension",
            message: `Extension "${key}" cannot be represented in OpenAI Chat request`,
            fidelity: "LOSSY",
            field: `extensions.${key}`,
          });
        }
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
): ParsedMessages {
  if (!Array.isArray(raw)) throw validationError("messages must be an array");
  const system: ContentPart[] = [];
  const messages: CanonicalMessage[] = [];

  for (let i = 0; i < raw.length; i++) {
    const m = raw[i] as Record<string, unknown> | null | undefined;
    if (!m || typeof m !== "object") {
      throw validationError(`messages[${i}] must be an object`);
    }
    const role = m.role;
    if (role === "system" || role === "developer") {
      system.push(...parseUserParts(m.content, ctx));
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
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: m.tool_call_id,
            content: parseUserParts(m.content, ctx),
          },
        ],
      });
    } else {
      ctx.warnings.push({
        code: "unknown_role",
        message: `Unknown OpenAI message role "${String(role)}" skipped`,
        fidelity: "LOSSY",
        field: `messages[${i}].role`,
      });
    }
  }

  return { system: system.length ? system : undefined, messages };
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
        message: `Unknown OpenAI content block type "${String(b.type)}" skipped`,
        fidelity: "LOSSY",
        field: `content.${String(b.type)}`,
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
): unknown[] {
  const out: unknown[] = [];
  if (canonical.system?.length) {
    const system = stripAnthropicBillingHeaders(canonical.system, ctx);
    if (system.length) {
      out.push({ role: "system", content: renderUserContent(system, ctx) });
    }
  }
  for (const m of canonical.messages) {
    if (m.role === "system") {
      const system = stripAnthropicBillingHeaders(m.content, ctx);
      if (system.length) {
        out.push({ role: "system", content: renderUserContent(system, ctx) });
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
        ctx.warnings.push({
          code: "image_lossy",
          message: "Base64 image cannot be represented in OpenAI Chat request",
          fidelity: "LOSSY",
          field: "content.image",
        });
        return null;
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
