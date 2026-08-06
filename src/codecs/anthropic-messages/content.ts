/**
 * Anthropic content-block mapping (shared by request and response codecs).
 *
 * Opaque thinking fields (signature, redacted data) are preserved verbatim and
 * never parsed or rewritten (TH-001).
 */
import type { ContentPart, ImageSource } from "../../ir/types.js";
import { validationError } from "../../errors.js";
import type { CodecContext } from "../protocol-adapter.js";

export function toImageSource(block: {
  source?: unknown;
}): ImageSource {
  const src = block.source as
    | { type: string; media_type?: string; data?: string; url?: string }
    | undefined;
  if (!src) throw validationError("image block is missing source");
  if (src.type === "base64") {
    if (typeof src.data !== "string" || typeof src.media_type !== "string") {
      throw validationError("base64 image requires media_type and data");
    }
    return { type: "base64", mediaType: src.media_type, data: src.data };
  }
  if (src.type === "url") {
    if (typeof src.url !== "string") throw validationError("url image requires url");
    return { type: "url", url: src.url };
  }
  throw validationError(`unsupported image source type: ${String(src.type)}`);
}

export function renderImageSource(source: ImageSource): unknown {
  return source.type === "base64"
    ? { type: "base64", media_type: source.mediaType, data: source.data }
    : { type: "url", url: source.url };
}

/** Parse an Anthropic content value (string or array of blocks) into parts. */
export function parseAnthropicContent(
  content: unknown,
  ctx: CodecContext,
): ContentPart[] {
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    throw validationError("content must be a string or an array of blocks");
  }
  const parts: ContentPart[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      throw validationError("content block must be an object");
    }
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "text":
        if (typeof b.text !== "string") throw validationError("text block requires a string text");
        parts.push({ type: "text", text: b.text });
        break;
      case "image":
        parts.push({ type: "image", source: toImageSource(b) });
        break;
      case "tool_use":
        if (typeof b.id !== "string" || typeof b.name !== "string") {
          throw validationError("tool_use block requires id and name");
        }
        parts.push({
          type: "tool_call",
          id: b.id,
          name: b.name,
          argumentsText: JSON.stringify(b.input ?? {}),
        });
        break;
      case "tool_result":
        if (typeof b.tool_use_id !== "string") {
          throw validationError("tool_result block requires tool_use_id");
        }
        parts.push({
          type: "tool_result",
          toolCallId: b.tool_use_id,
          content: parseAnthropicContent(b.content ?? "", ctx),
          isError: b.is_error === true,
        });
        break;
      case "thinking":
        parts.push({
          type: "reasoning",
          text: typeof b.thinking === "string" ? b.thinking : undefined,
          signature: typeof b.signature === "string" ? b.signature : undefined,
          providerMetadata: { anthropicBlock: "thinking" },
        });
        break;
      case "redacted_thinking":
        parts.push({
          type: "reasoning",
          encryptedContent: typeof b.data === "string" ? b.data : undefined,
          providerMetadata: { anthropicBlock: "redacted_thinking" },
        });
        break;
      default:
        ctx.warnings.push({
          code: "unknown_content_block",
          message: `Unknown Anthropic content block type "${String(b.type)}" preserved in extensions`,
          fidelity: "LOSSY",
          field: `content.${String(b.type)}`,
        });
        parts.push({ type: "text", text: "" });
    }
  }
  return parts;
}

/** Render canonical parts back to Anthropic content blocks. */
export function renderAnthropicContent(parts: ContentPart[]): unknown[] {
  const blocks: unknown[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        blocks.push({ type: "text", text: part.text });
        break;
      case "image":
        blocks.push({ type: "image", source: renderImageSource(part.source) });
        break;
      case "tool_call":
        blocks.push({
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: safeParseJson(part.argumentsText),
        });
        break;
      case "tool_result":
        blocks.push({
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: renderToolResultContent(part.content),
          ...(part.isError ? { is_error: true } : {}),
        });
        break;
      case "reasoning":
        if (
          (part.providerMetadata as { anthropicBlock?: string } | undefined)
            ?.anthropicBlock === "redacted_thinking"
        ) {
          blocks.push({
            type: "redacted_thinking",
            data: part.encryptedContent ?? "",
          });
        } else {
          blocks.push({
            type: "thinking",
            thinking: part.text ?? "",
            ...(part.signature ? { signature: part.signature } : {}),
          });
        }
        break;
    }
  }
  return blocks;
}

function renderToolResultContent(parts: ContentPart[]): string | unknown[] {
  const text = parts.filter((p) => p.type === "text").map((p) => p.text);
  if (parts.length === text.length) return text.join("");
  return parts.map((p) =>
    p.type === "text" ? { type: "text", text: p.text } : p,
  );
}

export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
