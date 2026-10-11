/**
 * Privacy security invariants (P6): cross-part splits, error-path isolation
 * and egress posture. Covers PT-39/47/56 and generalizes PT-66.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/index.js";
import type { PrivacyRecognizer } from "../../src/index.js";

const PHONE = "13800138000";

function phoneRecognizer(): PrivacyRecognizer {
  return {
    priority: 1,
    recognize(text) {
      const out = [];
      let idx = text.indexOf(PHONE);
      while (idx !== -1) {
        out.push({ start: idx, end: idx + PHONE.length, type: "phone" });
        idx = text.indexOf(PHONE, idx + 1);
      }
      return out;
    }
  };
}

interface Capture {
  fetch: typeof fetch;
  lastBody: () => unknown;
}

function capturingFetch(handler: (req: Request) => Response): Capture {
  let body: unknown;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as RequestInfo, init);
    body = await req.json();
    return handler(req);
  }) as typeof fetch;
  return { fetch: fetchImpl, lastBody: () => body };
}

const okAnthropic = () =>
  new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

function openaiContentOptions(content: unknown): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": "sk" },
    body: {
      model: "gpt-4o",
      messages: [{ role: "user", content }],
    },
  };
}

describe("privacy security invariants", () => {
  it("never leaks a phone split across two text parts (PT-56 generalized)", async () => {
    for (let split = 1; split < PHONE.length; split++) {
      const cap = capturingFetch(okAnthropic);
      await translate.chat.messages({
        ...openaiContentOptions([
          { type: "text", text: PHONE.slice(0, split) },
          { type: "text", text: PHONE.slice(split) },
        ]),
        fetch: cap.fetch,
        privacy: { recognizers: [phoneRecognizer()] },
      });
      expect(JSON.stringify(cap.lastBody())).not.toContain(PHONE);
    }
  });

  it("keeps placeholders in the client error by default (PT-39/47)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "bad input <private_placeholder_phone_1>",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const response = await translate.chat.messages({
      ...openaiContentOptions(`call ${PHONE}`),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("<private_placeholder_phone_1>");
    expect(body.error.message).not.toContain(PHONE);
  });

  it("restores the client error only under trusted_client (PT-39/47)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "bad input <private_placeholder_phone_1>",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const response = await translate.chat.messages({
      ...openaiContentOptions(`call ${PHONE}`),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()], errorRestore: "trusted_client" },
    });
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain(PHONE);
  });

  it("treats an opaque upstream error as sanitized diagnostics", async () => {
    const cap = capturingFetch(
      () =>
        new Response("not json at all", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
    );
    const response = await translate.chat.messages({
      ...openaiContentOptions(`call ${PHONE}`),
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("not json at all");
  });

  it("leaves oversized response tool arguments unrestored (PT-40)", async () => {
    const cap = capturingFetch(
      () =>
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "f",
                input: { blob: "x".repeat(200), ref: "<private_placeholder_phone_1>" },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    let overflowed = false;
    const response = await translate.chat.messages({
      ...openaiContentOptions(`call ${PHONE}`),
      fetch: cap.fetch,
      privacy: {
        recognizers: [phoneRecognizer()],
        streaming: { maxToolArgumentBytes: 50 },
      },
      onPrivacyComplete: (report) => {
        overflowed = report.warnings.some((w) => w.code === "privacy_buffer_overflow");
      },
    });
    const body = (await response.json()) as {
      choices: { message: { tool_calls?: { function: { arguments: string } }[] } };
    };
    expect(overflowed).toBe(true);
    expect(body.choices[0].message.tool_calls?.[0].function.arguments).toContain(
      "<private_placeholder_phone_1>",
    );
  });

  it("rejects a range crossing a cache breakpoint (PT-67)", async () => {
    const cap = capturingFetch(okAnthropic);
    await expect(
      translate.messages.chat({
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: "Bearer sk" },
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: PHONE.slice(0, 5) },
                {
                  type: "text",
                  text: PHONE.slice(5),
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
          ],
        },
        fetch: cap.fetch,
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).rejects.toMatchObject({
      kind: "privacy",
      code: "privacy_cross_part_cache_break",
    });
  });

  it("redacts the same split when no cache breakpoint is present (PT-67)", async () => {
    const cap = capturingFetch(okAnthropic);
    await expect(
      translate.messages.chat({
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: "Bearer sk" },
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: PHONE.slice(0, 5) },
                { type: "text", text: PHONE.slice(5) },
              ],
            },
          ],
        },
        fetch: cap.fetch,
        privacy: { recognizers: [phoneRecognizer()] },
      }),
    ).resolves.toBeDefined();
    expect(JSON.stringify(cap.lastBody())).not.toContain(PHONE);
  });
});
