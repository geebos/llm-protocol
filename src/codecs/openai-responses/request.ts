/**
 * OpenAI Responses request codec (responses.md §3 parse, §5 render).
 *
 * parseRequest keeps the source item sequence as faithful as possible
 * (responses.md §3.3, P1-6): normalization happens only in target renderers.
 * renderRequest targets the Responses endpoint (/v1/responses), splitting
 * canonical messages into independent input items while preserving tool
 * call/result pairing by unique call_id (no per-call adjacency, v0.5 P0-4).
 *
 * Request-side ID boundary (§5.2A, v0.4 P0-2): native IDs are preserved,
 * absent IDs are omitted — no synthetic item IDs in outbound requests; a
 * synthetic call_id is generated only when a tool result needs association.
 */
import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
  CanonicalToolChoice,
  ContentPart,
  ImageSource,
  RequestCache,
  RequestIdentity,
} from "../../ir/types.js";
import type { ProviderProfile } from "../../capabilities/provider-profile.js";
import { unsupportedError, validationError } from "../../errors.js";
import type {
  CodecContext,
  RequestCodec,
  ToolCallEntry,
  ToolDefEntry,
} from "../protocol-adapter.js";
import {
  ensureToolCallRegistry,
  ensureToolDefinitionRegistry,
} from "../protocol-adapter.js";
import type { TranslationPolicies } from "../../ir/policies.js";
import { DEFAULT_POLICIES } from "../../ir/policies.js";
import { createSyntheticIdFactory } from "./ids.js";
import { registerToolCall, registerToolDefinition } from "./normalize.js";
import { validateTargetRequest } from "./validate.js";
import {
  applyFidelityPlan,
  buildFidelityPlan,
  collectRemediations,
  type Remediations,
} from "./fidelity-plan.js";

const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
type ReasoningEffort = (typeof EFFORT_VALUES)[number];

/** Custom/freeform tools degrade to a fixed single-string-input function schema. */
const CUSTOM_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { input: { type: "string" } },
};

/** Server-side / built-in tools (web_search, mcp, code interpreter, ...). */
const SERVER_SIDE_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "mcp",
  "code_interpreter",
  "computer_use",
  "computer",
  "file_search",
  "function_web_search",
]);

export function createOpenAiResponsesRequestCodec(
  profile: ProviderProfile,
  policies: TranslationPolicies = DEFAULT_POLICIES,
): RequestCodec {
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

      const ids = createSyntheticIdFactory();
      ctx.syntheticIds = ids;

      const parsedInput = parseInput(p.input, typeof p.instructions === "string" ? p.instructions : undefined, ctx, policies);
      const identity = parseIdentity(p);
      const cache = parseCache(p);
      const outputIncludes = parseIncludes(p);

      const thinking = parseThinking(p.reasoning);

      const extensions: Record<string, unknown> = {};
      for (const key of [
        "metadata",
        "service_tier",
        "stream_options",
        "background",
        "prompt",
        "store",
        "max_tool_calls",
        "truncation",
        "text",
        "top_logprobs",
        "stop",
      ] as const) {
        if (p[key] !== undefined) extensions[key] = p[key];
      }
      // stateful fields normalized to snake-case extensions keys (validate.ts
      // reads these exact keys).
      if (p.previous_response_id !== undefined) {
        extensions.previousResponseId = p.previous_response_id;
      }
      if (p.conversation !== undefined) extensions.conversation = p.conversation;
      if (p.max_tool_calls !== undefined) {
        extensions.maxToolCalls = p.max_tool_calls;
      }
      if (p.truncation !== undefined) extensions.truncation = p.truncation;
      if (p.top_logprobs !== undefined) {
        // v0.5 P1-5: request/response bidirectionally unmodeled -> LOSSY/UNSUPPORTED.
        extensions.topLogprobs = p.top_logprobs;
        ctx.warnings.push({
          code: "top_logprobs_unsupported",
          message:
            "top_logprobs is LOSSY/UNSUPPORTED (no token-logprob IR in v1); dropped when rendering cross-protocol",
          fidelity: "UNSUPPORTED",
          field: "top_logprobs",
        });
      }
      if (p.stop !== undefined) {
        // `stop` is not a standard Responses top-level field (v0.3 P1-5);
        // only forwarded when the target profile declares the extension.
        extensions.stop = p.stop;
        if (!profile.capabilities.responses?.responsesExtensions?.stop) {
          ctx.warnings.push({
            code: "stop_not_standard",
            message:
              "`stop` is not a standard Responses field; preserved as an extension, forwarded only if the target declares responsesExtensions.stop",
            fidelity: "COMPATIBLE",
            field: "stop",
          });
        }
      }
      if (p.text !== undefined) {
        const text = p.text as { format?: unknown; verbosity?: unknown } | undefined;
        if (text?.format !== undefined) extensions.responsesTextFormat = text.format;
        if (text?.verbosity !== undefined) extensions.responsesTextVerbosity = text.verbosity;
      }

      // unknown fields -> policy (default preserve_extension)
      const known = new Set([
        "model",
        "input",
        "instructions",
        "max_output_tokens",
        "temperature",
        "top_p",
        "reasoning",
        "parallel_tool_calls",
        "stream",
        "tools",
        "tool_choice",
        "allowed_tools",
        "include",
        "user",
        "safety_identifier",
        "prompt_cache_key",
        "prompt_cache_retention",
        ...Object.keys(extensions),
        "previous_response_id",
        "conversation",
        "text",
      ]);
      for (const key of Object.keys(p)) {
        if (known.has(key)) continue;
        switch (policies.unsupportedField) {
          case "reject":
            throw unsupportedError(`Unsupported Responses field "${key}" (rejected by policy)`);
          case "drop_with_warning":
            ctx.warnings.push({
              code: "dropped_unknown_field",
              message: `Unknown Responses field "${key}" dropped`,
              fidelity: "LOSSY",
              field: key,
            });
            break;
          case "preserve_extension":
          default:
            extensions[key] = p[key];
        }
      }

      // tools + tool_choice (+ allowed_tools) parse in tandem so an empty
      // filtered set can never leave a forced tool_choice dangling (§3.4).
      const { tools, toolChoice } = parseToolsAndChoice(p.tools, p.tool_choice, p.allowed_tools, ctx);

      const canonical: CanonicalRequest = {
        model: p.model,
        messages: parsedInput.messages,
        system: parsedInput.system,
        tools,
        toolChoice,
        generation: {
          ...(typeof p.max_output_tokens === "number" ? { maxTokens: p.max_output_tokens } : {}),
          ...(typeof p.temperature === "number" ? { temperature: p.temperature } : {}),
          ...(typeof p.top_p === "number" ? { topP: p.top_p } : {}),
        },
        thinking,
        parallelToolCalls:
          typeof p.parallel_tool_calls === "boolean" ? p.parallel_tool_calls : undefined,
        identity,
        cache,
        outputIncludes,
        extensions,
      };

      // authority-order normalization is lossy (v0.2 P1-9): mid-sequence
      // system/developer items merged to the prefix change timing.
      if (parsedInput.authorityReordered) {
        ctx.warnings.push({
          code: "authority_order_normalized",
          message:
            "Mid-sequence system/developer items were merged into the system prefix, changing ordering",
          fidelity: "LOSSY",
          field: "input",
        });
      }
      return canonical;
    },

    renderRequest(
      canonical: CanonicalRequest,
      streaming: boolean,
      ctx: CodecContext = { warnings: [] },
    ): unknown {
      ctx.syntheticIds ??= createSyntheticIdFactory();

      // Target Validation + Fidelity Plan run before the IR is touched (§10.0).
      const validation = validateTargetRequest(canonical, profile, ctx, policies);
      const plan = buildFidelityPlan(canonical, profile, validation, ctx, policies);
      applyFidelityPlan(plan, ctx);
      const remed = collectRemediations(plan);

      const body: Record<string, unknown> = {
        model: canonical.model,
        stream: streaming,
        input: renderInput(canonical, ctx),
      };
      // §5.1 default strategy: system lands as the leading developer message
      // inside input (not the separate `instructions` top-level field).

      if (canonical.generation?.maxTokens !== undefined) {
        body.max_output_tokens = canonical.generation.maxTokens;
      }
      if (!remed.dropSampling) {
        if (canonical.generation?.temperature !== undefined) {
          body.temperature = canonical.generation.temperature;
        }
        if (canonical.generation?.topP !== undefined) {
          body.top_p = canonical.generation.topP;
        }
      }
      if (canonical.thinking) {
        body.reasoning = renderThinking(canonical.thinking, remed, ctx);
      }
      if (canonical.parallelToolCalls !== undefined) {
        body.parallel_tool_calls = canonical.parallelToolCalls;
      }

      const tools = renderTools(canonical.tools ?? [], ctx);
      if (tools.length) body.tools = tools;
      if (canonical.toolChoice) {
        const rendered = renderToolChoice(canonical.toolChoice, ctx, remed);
        body.tool_choice = rendered.choice;
        if (rendered.allowedTools?.length) body.allowed_tools = rendered.allowedTools;
      }

      if (plan.includes.effective.length) {
        body.include = plan.includes.effective;
      }

      const ext = canonical.extensions ?? {};
      if (!remed.dropStateful) {
        if (ext.previousResponseId !== undefined) {
          body.previous_response_id = ext.previousResponseId;
        }
        if (ext.conversation !== undefined) body.conversation = ext.conversation;
        if (ext.store !== undefined) body.store = ext.store;
        if (ext.prompt !== undefined) body.prompt = ext.prompt;
      }
      if (!remed.dropMaxToolCalls && ext.maxToolCalls !== undefined) {
        body.max_tool_calls = ext.maxToolCalls;
      }
      if (!remed.dropTruncation && ext.truncation !== undefined) {
        body.truncation = ext.truncation;
      }
      for (const key of ["metadata", "service_tier", "stream_options", "background", "text"] as const) {
        if (ext[key] !== undefined) body[key] = ext[key];
      }
      if (!remed.dropIdentity && canonical.identity) {
        const id = canonical.identity;
        if (id.legacyEndUserId !== undefined) body.user = id.legacyEndUserId;
        if (id.safetyEndUserId !== undefined) body.safety_identifier = id.safetyEndUserId;
      }
      if (canonical.cache) {
        if (canonical.cache.affinityKey !== undefined) {
          body.prompt_cache_key = canonical.cache.affinityKey;
        }
        if (canonical.cache.retention !== undefined) {
          body.prompt_cache_retention = canonical.cache.retention;
        }
      }
      if (ext.stop !== undefined && profile.capabilities.responses?.responsesExtensions?.stop) {
        body.stop = ext.stop;
      }
      if (ext.topLogprobs !== undefined) {
        // v0.5 P1-5: no token-logprob IR -> not forwarded, warning already on parse.
        body.top_logprobs = undefined;
      }

      return body;
    },
  };
}

/* ------------------------------------------------------------------ */
/* parse: input items -> canonical messages                            */
/* ------------------------------------------------------------------ */

interface ParsedInput {
  system?: ContentPart[];
  messages: CanonicalMessage[];
  authorityReordered: boolean;
}

function parseInput(
  input: unknown,
  instructions: string | undefined,
  ctx: CodecContext,
  policies: TranslationPolicies,
): ParsedInput {
  if (typeof input === "string") {
    return {
      messages: input === "" ? [] : [{ role: "user", content: [{ type: "text", text: input }] }],
      authorityReordered: false,
    };
  }
  if (!Array.isArray(input)) {
    throw validationError("input must be a string or an item array");
  }

  const system: ContentPart[] = [];
  // §3.2: instructions first (whitespace preserved, pure-blank segments skipped),
  // then system/developer items appended in source order.
  if (instructions !== undefined && instructions !== "") {
    system.push({ type: "text", text: instructions });
  }
  const messages: CanonicalMessage[] = [];
  let pendingAssistant: CanonicalMessage | undefined;
  let pendingReasoning: ContentPart[] = [];
  let sawNonSystem = false;
  let authorityReordered = false;

  const flushAssistant = (): void => {
    if (pendingAssistant) {
      messages.push(pendingAssistant);
      pendingAssistant = undefined;
    }
  };

  for (const item of input) {
    if (!item || typeof item !== "object") {
      throw validationError("input item must be an object");
    }
    const it = item as Record<string, unknown>;
    switch (it.type) {
      case "message": {
        const role = it.role;
        if (role === "system" || role === "developer") {
          if (sawNonSystem) authorityReordered = true;
          system.push(...parseMessageContent(it.content, "system", ctx));
          continue;
        }
        sawNonSystem = true;
        flushAssistant();
        if (role === "user") {
          messages.push({
            role: "user",
            content: parseMessageContent(it.content, "user", ctx),
          });
        } else if (role === "assistant") {
          const content = parseMessageContent(it.content, "assistant", ctx);
          if (pendingReasoning.length) {
            content.unshift(...pendingReasoning);
            pendingReasoning = [];
          }
          pendingAssistant = { role: "assistant", content };
        } else {
          ctx.warnings.push({
            code: "unknown_item_role",
            message: `Unknown Responses message role "${String(role)}" skipped`,
            fidelity: "LOSSY",
            field: "input.message.role",
          });
        }
        continue;
      }
      case "function_call":
      case "custom_tool_call": {
        sawNonSystem = true;
        if (!pendingAssistant) {
          const content = pendingReasoning.splice(0);
          pendingAssistant = { role: "assistant", content };
        }
        pendingAssistant.content.push(parseToolCallItem(it, ctx, policies));
        continue;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        sawNonSystem = true;
        flushAssistant();
        const part = parseToolResultItem(it, ctx);
        const last = messages[messages.length - 1];
        if (last && last.role === "user") {
          last.content.push(part);
        } else {
          messages.push({ role: "user", content: [part] });
        }
        continue;
      }
      case "reasoning": {
        pendingReasoning.push(parseReasoningItem(it, ctx));
        continue;
      }
      default:
        ctx.warnings.push({
          code: "unknown_input_item",
          message: `Unknown Responses input item type "${String(it.type)}" skipped`,
          fidelity: "LOSSY",
          field: "input",
        });
    }
  }
  flushAssistant();
  if (pendingReasoning.length) {
    ctx.warnings.push({
      code: "reasoning_without_assistant",
      message: "Trailing reasoning item has no assistant message to attach to; dropped",
      fidelity: "LOSSY",
      field: "input.reasoning",
    });
  }
  return {
    system: system.length ? system : undefined,
    messages,
    authorityReordered,
  };
}

function parseMessageContent(
  content: unknown,
  _role: string,
  ctx: CodecContext,
): ContentPart[] {
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    throw validationError("message item content must be a string or an array");
  }
  const parts: ContentPart[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      throw validationError("content part must be an object");
    }
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "input_text":
      case "output_text":
        if (typeof b.text !== "string") {
          throw validationError(`${b.type} part requires a string text`);
        }
        if (b.text !== "") parts.push({ type: "text", text: b.text });
        break;
      case "input_image":
        parts.push({ type: "image", source: parseImagePart(b) });
        break;
      case "input_file":
        parts.push(parseFilePart(b));
        break;
      case "refusal":
        if (typeof b.refusal !== "string") {
          throw validationError("refusal part requires a string refusal");
        }
        parts.push({ type: "refusal", text: b.refusal });
        break;
      default:
        ctx.warnings.push({
          code: "unknown_content_part",
          message: `Unknown Responses content part type "${String(b.type)}" skipped`,
          fidelity: "LOSSY",
          field: "input.message.content",
        });
    }
  }
  return parts;
}

function parseImagePart(b: Record<string, unknown>): ImageSource {
  const url = b.image_url;
  if (typeof url !== "string") {
    throw validationError("input_image part requires a string image_url");
  }
  const dataUri = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (dataUri) {
    const mediaType = dataUri[1] || "application/octet-stream";
    if (dataUri[2] === ";base64") {
      return { type: "base64", mediaType, data: dataUri[3] };
    }
    // Non-base64 data URIs are not representable; keep the raw URL string.
    return { type: "url", url };
  }
  return { type: "url", url };
}

function parseFilePart(b: Record<string, unknown>): ContentPart {
  const fileData = b.file_data as { type?: unknown; data?: unknown; mime_type?: unknown; url?: unknown } | undefined;
  const filename = typeof b.filename === "string" ? b.filename : undefined;
  if (fileData?.type === "base64") {
    if (typeof fileData.data !== "string") {
      throw validationError("input_file base64 requires file_data.data");
    }
    return {
      type: "file",
      source: {
        type: "base64",
        mediaType: typeof fileData.mime_type === "string" ? fileData.mime_type : "application/octet-stream",
        data: fileData.data,
      },
      filename,
    };
  }
  if (fileData?.type === "url" && typeof fileData.url === "string") {
    return { type: "file", source: { type: "url", url: fileData.url }, filename };
  }
  throw validationError("input_file requires file_data of type base64 or url");
}

function parseToolCallItem(
  it: Record<string, unknown>,
  ctx: CodecContext,
  policies: TranslationPolicies,
): ContentPart {
  const isCustom = it.type === "custom_tool_call";
  if (typeof it.name !== "string") {
    throw validationError(`${String(it.type)} item requires a string name`);
  }
  const normalizedName = flattenToolName(it.name, ctx).normalizedName;
  const callId =
    typeof it.call_id === "string"
      ? it.call_id
      : policies.generateMissingIds
        ? ctx.syntheticIds?.callId() ?? `call_${Math.random().toString(36).slice(2, 8)}`
        : (() => {
            ctx.warnings.push({
              code: "missing_call_id",
              message: `Tool call "${it.name}" has no call_id; left unassociated`,
              fidelity: "LOSSY",
              field: "input.tool_call.call_id",
            });
            return `call_${Math.random().toString(36).slice(2, 8)}`;
          })();
  const def = resolveDefinitionSafe(ctx, normalizedName);
  const executionKind = def?.executionKind === "custom" ? "custom" : isCustom ? "custom" : "function";
  const nameKind = def?.nameKind ?? (isCustom ? "plain" : "plain");

  registerToolCall(ctx, callId, {
    normalizedToolName: normalizedName,
    originalName: typeof it.name === "string" ? it.name : normalizedName,
    executionKind,
    nameKind,
  });

  if (executionKind === "custom") {
    return {
      type: "tool_call",
      kind: "custom",
      id: callId,
      name: normalizedName,
      inputText: typeof it.input === "string" ? it.input : String(it.input ?? ""),
    };
  }
  return {
    type: "tool_call",
    kind: "function",
    id: callId,
    name: normalizedName,
    argumentsText: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.input ?? {}),
  };
}

function parseToolResultItem(it: Record<string, unknown>, ctx: CodecContext): ContentPart {
  const callId = typeof it.call_id === "string" ? it.call_id : "";
  if (!callId) {
    throw validationError(`${String(it.type)} item requires a call_id`);
  }
  const entry = resolveCallByCallIdSafe(ctx, callId);
  const content = parseResultContent(it.output, ctx);
  return {
    type: "tool_result",
    toolCallId: callId,
    content,
    isError: it.status === "error",
  };
}

function parseResultContent(output: unknown, ctx: CodecContext): ContentPart[] {
  if (typeof output === "string") {
    return output === "" ? [] : [{ type: "text", text: output }];
  }
  if (Array.isArray(output)) {
    const parts: ContentPart[] = [];
    for (const block of output) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "output_text" && typeof b.text === "string" && b.text !== "") {
        parts.push({ type: "text", text: b.text });
      } else if (b.type === "input_image") {
        parts.push({ type: "image", source: parseImagePart(b) });
      } else if (b.type === "input_file") {
        parts.push(parseFilePart(b));
      } else {
        ctx.warnings.push({
          code: "unknown_output_part",
          message: `Unknown Responses output part type "${String(b.type)}" skipped`,
          fidelity: "LOSSY",
          field: "input.tool_call_output",
        });
      }
    }
    return parts;
  }
  return [];
}

function parseReasoningItem(it: Record<string, unknown>, ctx: CodecContext): ContentPart {
  const summaryParts = parseReasoningSubParts(it.summary, (s) => ({ text: s.text as string, summaryIndex: s.i }));
  const textParts = parseReasoningSubParts(it.content, (s) => ({ text: s.text as string, contentIndex: s.i }));
  const part: ContentPart = {
    type: "reasoning",
    ...(summaryParts.length === 1 ? { summary: summaryParts[0].text } : {}),
    ...(summaryParts.length > 1 ? { summaryParts } : {}),
    ...(textParts.length === 1 ? { text: textParts[0].text } : {}),
    ...(textParts.length > 1 ? { textParts } : {}),
    ...(typeof it.encrypted_content === "string"
      ? { encryptedContent: it.encrypted_content }
      : {}),
  };
  return part;
}

function parseReasoningSubParts(
  raw: unknown,
  map: (s: { text: string; i: number }) => { text: string; summaryIndex?: number; contentIndex?: number },
): Array<{ text: string; summaryIndex?: number; contentIndex?: number }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s): s is Record<string, unknown> =>
        !!s && typeof s === "object" && typeof (s as { text?: unknown }).text === "string",
    )
    .map((s, i) => map({ text: s.text as string, i }));
}

function resolveDefinitionSafe(ctx: CodecContext, normalizedName: string): ToolDefEntry | undefined {
  return ensureToolDefinitionRegistry(ctx).map.get(normalizedName);
}

function resolveCallByCallIdSafe(ctx: CodecContext, callId: string): ToolCallEntry | undefined {
  return ensureToolCallRegistry(ctx).byCallId.get(callId);
}

/* ------------------------------------------------------------------ */
/* parse: tools / tool_choice / allowed_tools                         */
/* ------------------------------------------------------------------ */

function parseToolsAndChoice(
  toolsRaw: unknown,
  choiceRaw: unknown,
  allowedRaw: unknown,
  ctx: CodecContext,
): { tools?: CanonicalTool[]; toolChoice?: CanonicalToolChoice } {
  const tools: CanonicalTool[] = [];
  const serverSide: string[] = [];
  const allowed = Array.isArray(allowedRaw)
    ? allowedRaw.filter((a): a is string => typeof a === "string")
    : undefined;

  if (toolsRaw !== undefined) {
    if (!Array.isArray(toolsRaw)) throw validationError("tools must be an array");
    for (const t of toolsRaw) {
      if (!t || typeof t !== "object") throw validationError("tool must be an object");
      const tool = t as Record<string, unknown>;
      const type = typeof tool.type === "string" ? tool.type : "function";
      if (SERVER_SIDE_TOOL_TYPES.has(type)) {
        serverSide.push(type);
        ctx.warnings.push({
          code: "server_side_tool_filtered",
          message: `Server-side tool "${String(tool.name ?? type)}" (${type}) is not canonicalized in v1 (client-executed tools only); filtered`,
          fidelity: "LOSSY",
          field: `tools.${String(tool.name ?? type)}`,
        });
        continue;
      }
      const name = typeof tool.name === "string" ? tool.name : undefined;
      if (!name) throw validationError("tool requires a string name");
      const def = registerDefinition(name, type, tool, ctx);
      if (def.executionKind === "custom") {
        tools.push({
          name: def.normalizedName,
          description: typeof tool.description === "string" ? tool.description : undefined,
          inputSchema: CUSTOM_INPUT_SCHEMA,
        });
      } else {
        const parameters =
          tool.parameters !== undefined && typeof tool.parameters === "object"
            ? (tool.parameters as Record<string, unknown>)
            : {};
        tools.push({
          name: def.normalizedName,
          description: typeof tool.description === "string" ? tool.description : undefined,
          inputSchema: parameters,
          strict: tool.strict === true ? true : tool.strict === false ? false : undefined,
        });
      }
    }
  }

  // allowed_tools narrows the effective tool subset; server-side tools listed
  // there stay UNSUPPORTED (they were already filtered above).
  const effectiveTools = allowed
    ? tools.filter((t) => allowed.includes(t.name))
    : tools;

  let toolChoice: CanonicalToolChoice | undefined;
  const parsed = parseToolChoice(choiceRaw, ctx);
  const forced = parsed?.type === "required" || parsed?.type === "tool";
  if (forced && effectiveTools.length === 0) {
    ctx.warnings.push({
      code: "empty_tools_forced_choice",
      message:
        "Filtered tool list is empty but tool_choice forces a tool; defaulting to auto",
      fidelity: "LOSSY",
      field: "tool_choice",
    });
    toolChoice = { type: "auto" };
  } else {
    toolChoice = parsed;
  }

  return {
    tools: effectiveTools.length ? effectiveTools : undefined,
    toolChoice,
  };
}

function registerDefinition(
  originalName: string,
  type: string,
  tool: Record<string, unknown>,
  ctx: CodecContext,
): ToolDefEntry {
  const { namespace, normalizedName } = flattenToolName(originalName, ctx);
  const executionKind = type === "custom" ? "custom" : "function";
  const entry: ToolDefEntry = {
    executionKind,
    nameKind: namespace !== undefined ? "namespaced" : "plain",
    originalName,
    ...(namespace !== undefined ? { namespace } : {}),
    normalizedName,
    ...(tool.parameters !== undefined && typeof tool.parameters === "object"
      ? { schema: tool.parameters as Record<string, unknown> }
      : {}),
  };
  registerToolDefinition(ctx, entry);
  return entry;
}

function flattenToolName(name: string, ctx: CodecContext): { namespace?: string; normalizedName: string } {
  // Namespace separators: "ns.child" or "ns::child". Flatten to `ns__child`.
  const sep = name.includes("::") ? "::" : name.includes(".") ? "." : undefined;
  if (!sep) return { normalizedName: name };
  const [ns, ...rest] = name.split(sep);
  if (!ns || rest.length === 0) return { normalizedName: name };
  const child = rest.join(sep);
  return { namespace: ns, normalizedName: `${ns}__${child}` };
}

function parseToolChoice(
  choice: unknown,
  ctx: CodecContext,
): CanonicalToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "required" };
  if (choice === "none" || choice === "manual") return { type: "none" };
  if (typeof choice === "object" && choice !== null) {
    const c = choice as { type?: unknown; name?: unknown };
    if ((c.type === "function" || c.type === "custom") && typeof c.name === "string") {
      return { type: "tool", name: flattenToolName(c.name, ctx).normalizedName };
    }
  }
  throw validationError(`unsupported Responses tool_choice value`);
}

/* ------------------------------------------------------------------ */
/* parse: top-level identity / cache / includes / reasoning           */
/* ------------------------------------------------------------------ */

function parseIdentity(p: Record<string, unknown>): RequestIdentity | undefined {
  const identity: RequestIdentity = {};
  if (typeof p.user === "string") identity.legacyEndUserId = p.user;
  if (typeof p.safety_identifier === "string") identity.safetyEndUserId = p.safety_identifier;
  return Object.keys(identity).length ? identity : undefined;
}

function parseCache(p: Record<string, unknown>): RequestCache | undefined {
  const cache: RequestCache = {};
  if (typeof p.prompt_cache_key === "string") cache.affinityKey = p.prompt_cache_key;
  if (p.prompt_cache_retention !== undefined) cache.retention = p.prompt_cache_retention;
  return Object.keys(cache).length ? cache : undefined;
}

function parseIncludes(p: Record<string, unknown>) {
  if (!Array.isArray(p.include)) return undefined;
  return {
    requestedIncludes: p.include.filter((i): i is string => typeof i === "string"),
  };
}

function parseThinking(reasoning: unknown) {
  if (!reasoning || typeof reasoning !== "object") return undefined;
  const r = reasoning as { effort?: unknown };
  if (typeof r.effort === "string" && (EFFORT_VALUES as readonly string[]).includes(r.effort)) {
    return { mode: "adaptive" as const, effort: r.effort as ReasoningEffort };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* render: canonical -> Responses request                              */
/* ------------------------------------------------------------------ */

function renderInput(canonical: CanonicalRequest, ctx: CodecContext): unknown[] {
  const items: unknown[] = [];
  // Default: developer message as the first input item (§5.1).
  if (canonical.system?.length) {
    items.push({
      type: "message",
      role: "developer",
      content: canonical.system
        .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
        .map((p) => ({ type: "input_text", text: p.text })),
    });
  }
  for (const m of canonical.messages) {
    items.push(...renderMessage(m, ctx));
  }
  return items;
}

function renderMessage(m: CanonicalMessage, ctx: CodecContext): unknown[] {
  if (m.role === "system") {
    // High-authority system message stays high authority as a developer item.
    return [
      {
        type: "message",
        role: "developer",
        content: m.content
          .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
          .map((p) => ({ type: "input_text", text: p.text })),
      },
    ];
  }

  const textParts = m.content.filter(
    (p): p is Extract<ContentPart, { type: "text" }> => p.type === "text",
  );
  const imageParts = m.content.filter(
    (p): p is Extract<ContentPart, { type: "image" }> => p.type === "image",
  );
  const fileParts = m.content.filter(
    (p): p is Extract<ContentPart, { type: "file" }> => p.type === "file",
  );
  const refusalParts = m.content.filter(
    (p): p is Extract<ContentPart, { type: "refusal" }> => p.type === "refusal",
  );
  const calls = m.content.filter(
    (p): p is Extract<ContentPart, { type: "tool_call" }> => p.type === "tool_call",
  );
  const results = m.content.filter(
    (p): p is Extract<ContentPart, { type: "tool_result" }> => p.type === "tool_result",
  );
  const reasoningParts = m.content.filter(
    (p): p is Extract<ContentPart, { type: "reasoning" }> => p.type === "reasoning",
  );

  const items: unknown[] = [];
  const media: unknown[] = [
    ...imageParts.map((p) => renderImagePart(p.source)),
    ...fileParts.map((p) => renderFilePart(p)),
  ];

  if (m.role === "assistant") {
    const content: unknown[] = [];
    for (const t of textParts) content.push({ type: "output_text", text: t.text });
    for (const r of refusalParts) {
      content.push({ type: "refusal", refusal: r.text });
    }
    if (content.length) {
      items.push({ type: "message", role: "assistant", content });
    }
    for (const c of calls) {
      items.push(renderToolCallItem(c, ctx));
    }
  } else {
    // user turn: text + media in one message item; tool results as separate
    // output items (call/result adjacency is NOT required, v0.5 P0-4).
    const content: unknown[] = [];
    for (const t of textParts) content.push({ type: "input_text", text: t.text });
    content.push(...media);
    if (content.length) {
      items.push({ type: "message", role: "user", content });
    }
    for (const r of results) {
      items.push(renderToolResultItem(r, ctx));
    }
  }

  for (const r of reasoningParts) {
    items.push(renderReasoningItem(r, ctx));
  }
  return items;
}

function renderImagePart(source: ImageSource): unknown {
  if (source.type === "base64") {
    return {
      type: "input_image",
      image_url: `data:${source.mediaType};base64,${source.data}`,
    };
  }
  return { type: "input_image", image_url: source.url };
}

function renderFilePart(p: Extract<ContentPart, { type: "file" }>): unknown {
  const base: Record<string, unknown> = {
    type: "input_file",
    ...(p.filename !== undefined ? { filename: p.filename } : {}),
  };
  if (p.source.type === "base64") {
    return {
      ...base,
      file_data: { type: "base64", data: p.source.data, mime_type: p.source.mediaType },
    };
  }
  return { ...base, file_data: { type: "url", url: p.source.url } };
}

function renderToolCallItem(
  c: Extract<ContentPart, { type: "tool_call" }>,
  ctx: CodecContext,
): unknown {
  const def = resolveDefinitionSafe(ctx, c.name);
  const entry = resolveCallByCallIdSafe(ctx, c.id);
  // Custom semantics restored from the definition/call registry; otherwise the
  // payload kind decides.
  const isCustom = entry?.executionKind === "custom" || def?.executionKind === "custom";
  if (c.kind === "custom" || isCustom) {
    ctx.warnings.push({
      code: "custom_tool_call_rendered",
      message: `Custom tool call "${c.name}" rendered with freeform input`,
      fidelity: "EXACT",
      field: `input.custom_tool_call.${c.id}`,
    });
    return {
      type: "custom_tool_call",
      name: c.name,
      call_id: c.id,
      input: c.kind === "custom" ? c.inputText : String((c as { inputText?: string }).inputText ?? ""),
    };
  }
  return {
    type: "function_call",
    name: c.name,
    call_id: c.id,
    arguments: c.argumentsText,
  };
}

function renderToolResultItem(
  r: Extract<ContentPart, { type: "tool_result" }>,
  ctx: CodecContext,
): unknown {
  const entry = resolveCallByCallIdSafe(ctx, r.toolCallId);
  const isCustom = entry?.executionKind === "custom";
  const type = isCustom ? "custom_tool_call_output" : "function_call_output";
  const output =
    r.content.length === 1 && r.content[0]?.type === "text"
      ? (r.content[0] as Extract<ContentPart, { type: "text" }>).text
      : r.content.map((p) => {
          if (p.type === "text") return { type: "output_text", text: p.text };
          if (p.type === "image") return renderImagePart(p.source);
          if (p.type === "file") return renderFilePart(p);
          return { type: "output_text", text: "" };
        });
  return {
    type,
    call_id: r.toolCallId,
    output,
    ...(r.isError ? { status: "error" } : {}),
  };
}

function renderReasoningItem(
  r: Extract<ContentPart, { type: "reasoning" }>,
  ctx: CodecContext,
): unknown {
  // signature/encryptedContent never enter public Responses reasoning fields
  // cross-provider (responses.md §11.4 native mode): dropped with a warning.
  if (r.signature !== undefined || r.encryptedContent !== undefined) {
    ctx.warnings.push({
      code: "reasoning_carrier_dropped",
      message:
        "Provider reasoning signature/encrypted content is not replayed into public Responses fields (native mode)",
      fidelity: "LOSSY",
      field: "input.reasoning",
    });
  }
  const summary = r.summaryParts ?? (r.summary !== undefined ? [{ text: r.summary }] : []);
  const text = r.textParts ?? (r.text !== undefined ? [{ text: r.text }] : []);
  const item: Record<string, unknown> = { type: "reasoning" };
  if (summary.length) {
    item.summary = summary.map((s) => ({ type: "summary_text", text: s.text }));
  }
  if (text.length) {
    item.content = text.map((t) => ({ type: "reasoning_text", text: t.text }));
  }
  return item;
}

function renderThinking(
  thinking: NonNullable<CanonicalRequest["thinking"]>,
  remed: Remediations,
  ctx: CodecContext,
): unknown {
  if (remed.dropEffort) return undefined;
  const r: Record<string, unknown> = {};
  if (thinking.mode === "adaptive" && thinking.effort !== undefined) {
    r.effort = thinking.effort;
  } else if (thinking.mode === "enabled" && thinking.budgetTokens !== undefined) {
    // Responses has no budget concept; effort approximates depth (COMPATIBLE).
    ctx.warnings.push({
      code: "thinking_budget_to_effort",
      message: `Anthropic-style thinking budget ${thinking.budgetTokens} approximated as effort for the Responses target`,
      fidelity: "COMPATIBLE",
      field: "reasoning",
    });
    r.effort = thinking.budgetTokens >= 20000 ? "high" : thinking.budgetTokens >= 8000 ? "medium" : "low";
  }
  return Object.keys(r).length ? r : undefined;
}

function renderTools(tools: CanonicalTool[], ctx: CodecContext): unknown[] {
  const out: unknown[] = [];
  for (const t of tools) {
    const def = resolveDefinitionSafe(ctx, t.name);
    if (def?.executionKind === "custom") {
      out.push({ type: "custom", name: def.originalName, description: t.description ?? "" });
    } else {
      out.push({
        type: "function",
        name: def?.originalName ?? t.name,
        description: t.description ?? "",
        parameters: t.inputSchema,
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      });
    }
  }
  return out;
}

function renderToolChoice(
  choice: CanonicalToolChoice,
  ctx: CodecContext,
  remed: Remediations,
): { choice: unknown; allowedTools?: string[] } {
  if (remed.setToolChoiceAuto) {
    return { choice: "auto" };
  }
  switch (choice.type) {
    case "auto":
      return { choice: "auto" };
    case "none":
      return { choice: "none" };
    case "required":
      return { choice: "required" };
    case "tool": {
      const def = resolveDefinitionSafe(ctx, choice.name);
      if (def?.executionKind === "custom") {
        return { choice: { type: "custom", name: def.originalName } };
      }
      return { choice: { type: "function", name: def?.originalName ?? choice.name } };
    }
  }
}
