/**
 * Fixture loading and mock upstream executor (10.4 Fixture Contract).
 *
 * Fixture scenarios run against a mock fetch that replays a fixed response or
 * SSE stream, so the whole translate() pipeline (request conversion, upstream
 * call, reverse conversion) is exercised offline without any provider.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProviderConfig } from "./types.js";
import type { FixtureSpec } from "./types.js";

const FIXTURES_ROOT = resolve(process.cwd(), "fixtures");

async function readJson<T>(rel: string): Promise<T> {
  const text = await readFile(resolve(FIXTURES_ROOT, rel), "utf-8");
  return JSON.parse(text) as T;
}

export async function readFixture<T>(rel: string): Promise<T> {
  return readJson<T>(rel);
}

export interface FixtureResponsePayload {
  /** Raw protocol response body (the `to`-protocol side). */
  body: unknown;
  status: number;
  /** SSE text when streaming. */
  stream?: string;
}

export async function loadFixtureResponse(
  spec: FixtureSpec,
): Promise<FixtureResponsePayload> {
  if (spec.streaming) {
    if (!spec.streamFile) throw new Error(`scenario fixture missing streamFile`);
    const stream = await readFile(resolve(FIXTURES_ROOT, spec.streamFile), "utf-8");
    return { body: {}, status: 200, stream };
  }
  if (!spec.responseFile) throw new Error(`scenario fixture missing responseFile`);
  const doc = await readJson<{ response?: unknown; status?: number; error?: unknown }>(
    spec.responseFile,
  );
  return {
    body: (doc.response ?? doc.error) as unknown,
    status: doc.status ?? 200,
  };
}

/**
 * Build a mock fetch executor for a fixture-backed scenario. Captures the
 * target request so assertions can verify the conversion, then replays the
 * fixture response (JSON or SSE) exactly once.
 */
export function mockProviderFetch(
  provider: ProviderConfig,
  payload: FixtureResponsePayload,
): {
  fetch: typeof globalThis.fetch;
  lastTargetRequest: () => Promise<{
    url: string;
    headers: Headers;
    body: unknown;
  }>;
} {
  let captured: { url: string; headers: Headers; body: unknown } | undefined;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req =
      input instanceof Request ? input : new Request(input as RequestInfo, init);
    let body: unknown = null;
    try {
      body = await req.clone().json();
    } catch {
      body = await req.clone().text();
    }
    captured = { url: req.url, headers: new Headers(req.headers), body };

    if (payload.stream !== undefined) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(payload.stream!));
          c.close();
        },
      });
      return new Response(stream, {
        status: payload.status,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify(payload.body), {
      status: payload.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    lastTargetRequest: async () => {
      if (!captured) throw new Error("fetch was never called");
      return captured;
    },
  };
}
