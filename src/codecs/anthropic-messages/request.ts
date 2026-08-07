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
      throw validationError(`unsupported thinking type "${String(t.type)}"`);
  }
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
      parallelToolCalls: parseDisableParallel(p.tool_choice),
      generation,
      thinking: parseThinking(p.thinking, p.output_config),
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
    // Anthropic requires well-formed turns (tool_result placement, no runs of
    // adjacent same-role turns); normalize before rendering (P0-7).
    const messages = normalizeAnthropicTurns(canonical.messages, ctx);
    if (messages.length) {
      body.messages = messages.map((m) => renderMessage(m, ctx));
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
        if (t.effort !== undefined) {
          body.output_config = { effort: t.effort };
        }
      }
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
