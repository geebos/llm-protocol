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
  "service_tier",
];

function parseSystem(
  system: unknown,
  ctx: CodecContext,
): ContentPart[] | undefined {
  if (system === undefined) return undefined;
  const parts = parseAnthropicContent(system, ctx);
  return parts.length ? parts : undefined;
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
      throw validationError(`messages[${i}] has unsupported role "${String(role)}"`);
    }
    return {
      role,
      content: parseAnthropicContent((m as { content?: unknown }).content ?? "", ctx),
    };
  });
}

function parseTools(tools: unknown, ctx: CodecContext): CanonicalTool[] | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw validationError("tools must be an array");
  return tools.map((t, i) => {
    const tool = t as { name?: unknown; description?: unknown; input_schema?: unknown };
    if (typeof tool.name !== "string") {
      throw validationError(`tools[${i}] requires a string name`);
    }
    if (tool.input_schema !== undefined && typeof tool.input_schema !== "object") {
      throw validationError(`tools[${i}].input_schema must be an object`);
    }
    return {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: (tool.input_schema as Record<string, unknown>) ?? {},
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
      throw validationError(`unsupported tool_choice type "${String(c.type)}"`);
  }
}

function parseThinking(thinking: unknown, ctx: CodecContext): CanonicalThinkingConfig | undefined {
  if (thinking === undefined) return undefined;
  const t = thinking as { type?: unknown; budget_tokens?: unknown };
  if (t.type === "disabled") return { enabled: false };
  if (t.type === "enabled") {
    return {
      enabled: true,
      budgetTokens: typeof t.budget_tokens === "number" ? t.budget_tokens : undefined,
    };
  }
  throw validationError(`unsupported thinking type "${String(t.type)}"`);
}

export const anthropicRequestCodec: RequestCodec = {
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

    return {
      model: p.model,
      messages: parseMessages(p.messages, ctx),
      system: parseSystem(p.system, ctx),
      tools: parseTools(p.tools, ctx),
      toolChoice: parseToolChoice(p.tool_choice, ctx),
      generation,
      thinking: parseThinking(p.thinking, ctx),
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

    if (canonical.system?.length) {
      body.system = simplifyTextBlocks(renderAnthropicContent(canonical.system));
    }
    if (canonical.messages.length) {
      body.messages = canonical.messages.map((m) => renderMessage(m, ctx));
    }
    if (canonical.tools?.length) {
      body.tools = canonical.tools.map((t) => {
        if (t.strict !== undefined) {
          ctx.warnings.push({
            code: "tool_strict",
            message: `Tool "${t.name}" strict flag is not representable in Anthropic`,
            fidelity: "LOSSY",
            field: `tools.${t.name}.strict`,
          });
        }
        return {
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          input_schema: t.inputSchema,
        };
      });
    }
    if (canonical.toolChoice) {
      body.tool_choice = renderToolChoice(canonical.toolChoice);
    }

    const gen = canonical.generation;
    if (gen?.temperature !== undefined) body.temperature = gen.temperature;
    if (gen?.topP !== undefined) body.top_p = gen.topP;
    if (gen?.stopSequences?.length) body.stop_sequences = gen.stopSequences;

    const ext = canonical.extensions ?? {};
    for (const key of ["topK", "metadata", "service_tier"] as const) {
      if (ext[key] !== undefined) body[key === "topK" ? "top_k" : key] = ext[key];
    }
    for (const key of Object.keys(ext)) {
      if (key !== "topK" && key !== "metadata" && key !== "service_tier") {
        ctx.warnings.push({
          code: "dropped_extension",
          message: `Extension "${key}" cannot be represented in Anthropic request`,
          fidelity: "LOSSY",
          field: `extensions.${key}`,
        });
      }
    }

    if (canonical.thinking) {
      body.thinking = canonical.thinking.enabled
        ? { type: "enabled", budget_tokens: canonical.thinking.budgetTokens }
        : { type: "disabled" };
    }

    return body;
  },
};

function renderMessage(m: CanonicalMessage, ctx: CodecContext): unknown {
  if (m.role === "system") {
    ctx.warnings.push({
      code: "system_in_messages",
      message: "System message folded into top-level system",
      fidelity: "COMPATIBLE",
      field: "messages.role",
    });
    return { role: "user", content: renderAnthropicContent(m.content) };
  }
  const role = m.role === "tool" ? "user" : m.role;
  const blocks = renderAnthropicContent(m.content);
  return {
    role,
    content: m.role === "assistant" ? blocks : simplifyUserContent(blocks),
  };
}

/** Single-text content renders as a plain string (Anthropic allows it). */
function simplifyTextBlocks(blocks: unknown[]): unknown {
  if (blocks.length === 1) {
    const b = blocks[0] as { type?: string; text?: string } | undefined;
    if (b?.type === "text" && b.text !== undefined) return b.text;
  }
  return blocks;
}

/** Single-text user content renders as a plain string (Anthropic allows it). */
function simplifyUserContent(blocks: unknown[]): unknown {
  return simplifyTextBlocks(blocks);
}

function renderToolChoice(choice: CanonicalToolChoice): unknown {
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

export { DEFAULT_MAX_TOKENS };
