/**
 * Structured-output format conversion (responses.md §6.1/§7, review round 2).
 *
 * Chat `response_format` and Responses `text.format` express the same
 * structured-output concept with different nesting: Chat wraps the json_schema
 * payload under `json_schema`, Responses flattens it to top-level
 * name/schema/strict. json_object is the same shape on both sides.
 *
 * Unrecognized shapes are dropped with an explicit warning — never silently.
 */
import type { CodecContext } from "./protocol-adapter.js";

/** Chat `response_format` -> Responses `text.format`. */
export function responsesTextFormatFromChat(
  format: unknown,
  ctx: CodecContext,
): unknown {
  if (!format || typeof format !== "object") {
    ctx.warnings.push({
      code: "response_format_dropped",
      message: "Chat response_format is not an object; dropped",
      fidelity: "LOSSY",
      field: "extensions.response_format",
    });
    return undefined;
  }
  const f = format as Record<string, unknown>;
  if (f.type === "json_object") return { type: "json_object" };
  if (f.type === "json_schema" && f.json_schema && typeof f.json_schema === "object") {
    const s = f.json_schema as Record<string, unknown>;
    const out: Record<string, unknown> = { type: "json_schema" };
    if (s.name !== undefined) out.name = s.name;
    if (s.schema !== undefined) out.schema = s.schema;
    if (s.strict !== undefined) out.strict = s.strict;
    return out;
  }
  ctx.warnings.push({
    code: "response_format_dropped",
    message: `Chat response_format type "${String(f.type)}" cannot be represented as Responses text.format; dropped`,
    fidelity: "LOSSY",
    field: "extensions.response_format",
  });
  return undefined;
}

/** Responses `text.format` -> Chat `response_format`. */
export function chatResponseFormatFromResponses(
  format: unknown,
  ctx: CodecContext,
): unknown {
  if (!format || typeof format !== "object") {
    ctx.warnings.push({
      code: "response_format_dropped",
      message: "Responses text.format is not an object; dropped",
      fidelity: "LOSSY",
      field: "extensions.responsesTextFormat",
    });
    return undefined;
  }
  const f = format as Record<string, unknown>;
  if (f.type === "json_object") return { type: "json_object" };
  if (f.type === "json_schema") {
    const out: Record<string, unknown> = { type: "json_schema" };
    if (f.schema !== undefined) {
      out.json_schema = {
        ...(f.name !== undefined ? { name: f.name } : {}),
        ...(f.schema !== undefined ? { schema: f.schema } : {}),
        ...(f.strict !== undefined ? { strict: f.strict } : {}),
      };
    } else if (f.json_schema && typeof f.json_schema === "object") {
      // Already Chat-shaped (e.g. round-tripped); keep verbatim.
      out.json_schema = f.json_schema;
    } else {
      ctx.warnings.push({
        code: "response_format_dropped",
        message: "Responses text.format json_schema has no schema; dropped",
        fidelity: "LOSSY",
        field: "extensions.responsesTextFormat",
      });
      return undefined;
    }
    return out;
  }
  ctx.warnings.push({
    code: "response_format_dropped",
    message: `Responses text.format type "${String(f.type)}" cannot be represented as Chat response_format; dropped`,
    fidelity: "LOSSY",
    field: "extensions.responsesTextFormat",
  });
  return undefined;
}
