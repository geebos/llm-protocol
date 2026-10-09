/**
 * Privacy configuration and cross-part / cache fidelity (P0/P2).
 * Covers PT-21/27/43/45/49/56/59.
 */
import { describe, expect, it } from "vitest";
import { translate } from "../../src/pipeline/translate.js";
import {
  createPrivacyEngine,
  type PrivacyRecognizer,
} from "../../src/index.js";

function phoneRecognizer(): PrivacyRecognizer {
  return {
    priority: 1,
    recognize(text) {
      const out = [];
      let idx = text.indexOf("13800138000");
      while (idx !== -1) {
        out.push({ start: idx, end: idx + 11, type: "phone" });
        idx = text.indexOf("13800138000", idx + 1);
      }
      return out;
    },
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

const okOpenAi = () =>
  new Response(
    JSON.stringify({
      id: "chatcmpl_1",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("privacy configuration", () => {
  it("does not inject a notice when system is false (PT-43)", async () => {
    const cap = capturingFetch(okAnthropic);
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()], system: false },
    });
    await forward(
      new Request("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect((cap.lastBody() as { system?: unknown }).system).toBeUndefined();
  });

  it("injects a custom notice only once (PT-43/44)", async () => {
    const cap = capturingFetch(okAnthropic);
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: cap.fetch,
      privacy: {
        recognizers: [phoneRecognizer()],
        system: "Custom notice: {template}",
      },
    });
    await forward(
      new Request("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "Custom notice: <private_placeholder_{type}_{N}>" },
            { role: "user", content: "hi" },
          ],
        }),
      }),
    );
    const system = JSON.stringify((cap.lastBody() as { system?: unknown }).system);
    expect(system.match(/Custom notice/g)?.length).toBe(1);
  });

  it("redacts a phone split across two text parts (PT-56)", async () => {
    const cap = capturingFetch(okAnthropic);
    const forward = translate({
      from: "openai-chat",
      to: "anthropic-messages",
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
    });
    await forward(
      new Request("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "call 13800" },
                { type: "text", text: "138000 now" },
              ],
            },
          ],
        }),
      }),
    );
    const json = JSON.stringify(cap.lastBody());
    expect(json).not.toContain("13800138000");
    expect(json).toContain("<private_placeholder_phone_1>");
  });

  it("preserves Anthropic cache_control through the IR (PT-49/59)", async () => {
    const cap = capturingFetch(okAnthropic);
    const forward = translate({
      from: "anthropic-messages",
      to: "anthropic-messages",
      fetch: cap.fetch,
      privacy: { recognizers: [phoneRecognizer()] },
    });
    await forward(
      new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "sk", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          system: [
            { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              name: "t",
              input_schema: { type: "object" },
              cache_control: { type: "ephemeral" },
            },
          ],
        }),
      }),
    );
    const body = cap.lastBody() as {
      system: { cache_control?: unknown }[];
      tools: { cache_control?: unknown }[];
    };
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("supports a custom template with a round trip (PT-21)", async () => {
    const engine = createPrivacyEngine();
    const session = engine.createSession("custom", { template: "[[{type}:{N}]]" });
    const redacted = await engine.redact("call 13800138000", session, [phoneRecognizer()]);
    expect(redacted).toBe("call [[phone:1]]");
    expect(engine.restore(redacted, session)).toBe("call 13800138000");
  });

  it("produces stable tagged placeholders (PT-27)", async () => {
    const captured: string[] = [];
    const run = async (): Promise<void> => {
      const cap = capturingFetch(okAnthropic);
      const forward = translate({
        from: "openai-chat",
        to: "anthropic-messages",
        fetch: cap.fetch,
        privacy: {
          recognizers: [phoneRecognizer()],
          mapping: { template: "<p_{type}_{N}_{tag}>", tagMode: true },
          tagKey: () => new Uint8Array([1, 2, 3, 4]),
          tagNamespace: "tenant-1",
        },
      });
      await forward(
        new Request("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "user", content: "call 13800138000" }],
          }),
        }),
      );
      captured.push(JSON.stringify(cap.lastBody()));
    };
    await run();
    await run();
    expect(captured[0]).toMatch(/<p_phone_1_[0-9a-f]{24}>/);
    // Stable key + namespace => identical placeholder bytes across requests.
    expect(captured[0]).toContain("<p_phone_1_");
    const tagA = captured[0].match(/<p_phone_1_([0-9a-f]{24})>/)?.[1];
    const tagB = captured[1].match(/<p_phone_1_([0-9a-f]{24})>/)?.[1];
    expect(tagA).toBeDefined();
    expect(tagA).toBe(tagB);
  });
});
