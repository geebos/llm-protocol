# llm-protocol

**English** | [简体中文](README.zh-CN.md)

A clean-room LLM protocol translation core: **Anthropic Messages ↔ OpenAI Chat** — bidirectional request/response/streaming translation that accepts and returns Node.js standard `Request` / `Response` objects, so it can be embedded into any HTTP framework.

## Features

| Capability | Support |
| --- | --- |
| Protocols | Anthropic Messages ↔ OpenAI Chat |
| Modes | Non-streaming JSON, SSE streaming |
| Content | system / multi-turn text / images / Tool definitions / Tool calls / Tool results / multi-turn resubmission / parallel calls |
| Thinking | thinking / redacted_thinking / signature bidirectional mapping, three policies: reject / drop_with_warning / provider_metadata |
| State | usage, finish/stop reason, ID, model, reverse error translation |
| Security | opaque credential passthrough, header sanitization, body size limits, timeouts, cancellation propagation, trace redaction |

**Not yet supported:** OpenAI Responses format `openai-responses`.

## Quick Start

### Install

```bash
npm install llm-protocol
```

Requires Node.js ≥ 20.

### Usage

```ts
import { translate } from "llm-protocol";

// Forward from an OpenAI Chat client to an Anthropic upstream
const forwardToAnthropic = translate({
  from: "openai-chat",
  to: "anthropic-messages",
});

const response = await forwardToAnthropic(
  new Request("https://api.anthropic.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${anthropicProviderKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hello" }],
    }),
  }),
);
```

The returned `Response` is back in the OpenAI Chat protocol. URL rewriting, auth headers, `anthropic-version`, body translation and reverse response translation are fully handled inside the factory.

### SSE streaming

Set `stream: true` and the response body becomes a real-time `ReadableStream`.

```ts
const response = await forwardToAnthropic(
  new Request("https://api.anthropic.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${anthropicProviderKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    }),
  }),
);

// The body is OpenAI Chat SSE; consume it frame by frame
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  for (const frame of buffer.split("\n\n")) {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    if (!data || data === "[DONE]") continue;
    const chunk = JSON.parse(data);
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) process.stdout.write(delta);
  }
}
```

## License

MIT
