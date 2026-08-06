/**
 * SSE frame parser/encoder (SR-001).
 *
 * Byte-level robustness requirements:
 * - UTF-8 characters split across chunk boundaries (TextDecoder streaming);
 * - CRLF and LF line endings, including a \r split across chunks;
 * - multi-line `data:` fields joined with \n;
 * - blank-line frame delimiters and `:` comment lines;
 * - unknown fields ignored.
 *
 * The parser is a TransformStream<Uint8Array, SSEFrame>; backpressure is
 * provided by the Web Streams machinery (SR-007).
 */

export interface SSEFrame {
  event: string;
  data: string;
  id?: string;
}

/** Split a decoded chunk into complete lines plus a pending partial tail. */
function splitLines(text: string, pending: string): { lines: string[]; rest: string } {
  const combined = pending + text;
  const lines = combined.split("\n");
  const rest = lines.pop() ?? "";
  // strip a trailing \r that ends a line (handles CRLF)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith("\r")) lines[i] = lines[i].slice(0, -1);
  }
  return { lines, rest };
}

export function createSSEParser(): TransformStream<Uint8Array, SSEFrame> {
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let event = "message";
  let data = "";
  let id: string | undefined;

  function flushFrame(controller: TransformStreamDefaultController<SSEFrame>): void {
    // A blank line terminates a frame. Only emit if we have data or an id.
    if (data !== "" || id !== undefined) {
      controller.enqueue({ event, data, id });
    }
    event = "message";
    data = "";
    id = undefined;
  }

  return new TransformStream<Uint8Array, SSEFrame>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      if (text.length === 0) return;
      const { lines, rest } = splitLines(text, pending);
      pending = rest;
      for (const line of lines) {
        if (line === "") {
          flushFrame(controller);
          continue;
        }
        if (line.startsWith(":")) continue; // comment
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        switch (field) {
          case "event":
            event = value;
            break;
          case "data":
            data = data === "" ? value : `${data}\n${value}`;
            break;
          case "id":
            id = value;
            break;
          default:
            // ignore unknown fields
            break;
        }
      }
    },
    flush(controller) {
      const text = decoder.decode();
      const { lines, rest } = splitLines(text, pending);
      pending = rest;
      for (const line of lines) {
        if (line === "") {
          flushFrame(controller);
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data = data === "" ? value : `${data}\n${value}`;
          else if (field === "event") event = value;
          else if (field === "id") id = value;
        }
      }
      if (pending !== "") {
        if (pending.startsWith(":")) {
          // trailing comment, ignore
        } else {
          const colon = pending.indexOf(":");
          const field = colon === -1 ? pending : pending.slice(0, colon);
          const value = colon === -1 ? "" : pending.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data = data === "" ? value : `${data}\n${value}`;
          else if (field === "event") event = value;
          else if (field === "id") id = value;
        }
      }
      if (data !== "" || id !== undefined) {
        controller.enqueue({ event, data, id });
      }
    },
  });
}

/** Encode one SSE frame into bytes (Anthropic-style named events by default). */
export function encodeSSE(
  event: string | undefined,
  data: string,
): Uint8Array {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  if (event !== undefined) parts.push(`event: ${event}`);
  for (const line of data.split("\n")) {
    parts.push(`data: ${line}`);
  }
  parts.push("");
  return encoder.encode(`${parts.join("\n")}\n`);
}

/** OpenAI-style: data-only frames with an optional final [DONE]. */
export function encodeDataFrame(data: string): Uint8Array {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  for (const line of data.split("\n")) {
    parts.push(`data: ${line}`);
  }
  parts.push("");
  return encoder.encode(`${parts.join("\n")}\n`);
}
