/**
 * SSE byte-level parser tests (SR-001, TC-016): framing, CRLF, byte-splitting,
 * multi-line data, comments and flush edges. Protocol-agnostic infrastructure.
 */
import { describe, expect, it } from "vitest";
import { createSSEParser, type SSEFrame } from "../src/streams/index.js";

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function bytesStream(text: string, chunkSize = Infinity): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (chunkSize === Infinity) {
        controller.enqueue(bytes);
      } else {
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.subarray(i, i + chunkSize));
        }
      }
      controller.close();
    },
  });
}

async function parseSSE(
  text: string,
  chunkSize = Infinity,
): Promise<SSEFrame[]> {
  return collect(bytesStream(text, chunkSize).pipeThrough(createSSEParser()));
}

{
  it("parses a basic data frame", async () => {
    const frames = await parseSSE("data: hello\n\n");
    expect(frames).toEqual([{ event: "message", data: "hello", id: undefined }]);
  });

  it("parses named events and ids", async () => {
    const frames = await parseSSE(
      "event: ping\nid: 1\ndata: {}\n\n",
    );
    expect(frames).toEqual([{ event: "ping", data: "{}", id: "1" }]);
  });

  it("joins multi-line data with newlines", async () => {
    const frames = await parseSSE("data: line1\ndata: line2\n\n");
    expect(frames[0].data).toBe("line1\nline2");
  });

  it("handles CRLF and comments", async () => {
    const frames = await parseSSE(
      ": a comment\r\n" + "data: x\r\n\r\n",
    );
    expect(frames).toEqual([{ event: "message", data: "x", id: undefined }]);
  });

  it("ignores a frame with only an id (no data)", async () => {
    const frames = await parseSSE("id: 5\n\n");
    expect(frames).toEqual([{ event: "message", data: "", id: "5" }]);
  });

  it("survives byte-level splitting including multi-byte UTF-8 (TC-016)", async () => {
    const input = "event: message_start\ndata: {\"text\":\"数据\"}\n\n";
    const frames1 = await parseSSE(input, 1);
    const framesAll = await parseSSE(input, 3);
    expect(frames1).toEqual(framesAll);
    expect(frames1[0].data).toBe('{"text":"数据"}');
  });

  it("survives a CR split across chunk boundaries", async () => {
    const frames = await parseSSE("data: a\r\ndata: b\r\n\r\n", 2);
    expect(frames).toEqual([{ event: "message", data: "a\nb", id: undefined }]);
  });

  it("flushes a trailing frame without a trailing blank line", async () => {
    const frames = await parseSSE("data: tail");
    expect(frames).toEqual([{ event: "message", data: "tail", id: undefined }]);
  });
}

{
  it("flushes a field-only frame at stream end (no data)", async () => {
    const out = await collect(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("id: 9\n\n"));
          c.close();
        },
      }).pipeThrough(createSSEParser()),
    );
    expect(out).toEqual([{ event: "message", data: "", id: "9" }]);
  });

  it("tolerates a trailing comment line at stream end", async () => {
    const out = await collect(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: x\n\n: trailing"));
          c.close();
        },
      }).pipeThrough(createSSEParser()),
    );
    expect(out).toEqual([{ event: "message", data: "x" }]);
  });
}
