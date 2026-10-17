# llm-protocol

**English** | [简体中文](README.zh-CN.md)

A clean-room LLM protocol translation core: **Anthropic Messages ↔ OpenAI Chat** — bidirectional request/response/streaming translation. Describe the upstream call with plain options (`url` / `headers` / `body`) and get back a standard `Response` in the source protocol, ready to embed in any HTTP framework.

## Features

| Capability | Support |
| --- | --- |
| Protocols | Anthropic Messages ↔ OpenAI Chat |
| Modes | Non-streaming JSON, SSE streaming |
| Content | system / multi-turn text / images / Tool definitions / Tool calls / Tool results / multi-turn resubmission / parallel calls |
| Thinking | thinking / redacted_thinking / signature bidirectional mapping, three policies: reject / drop_with_warning / provider_metadata |
| State | usage (unified), finish/stop reason, ID, model, reverse error translation |
| Fidelity | field-level droppability driven by `ProviderProfile` capabilities: droppable fields are recorded in `trace.drops`, non-droppable ones fail closed instead of being lost |
| Observability | per-call `onComplete` (request body, response body, canonical SSE events, unified usage), `logid`, diagnostic trace |
| Security | caller-owned credentials, final headers forwarded verbatim, body size limits, timeouts, cancellation propagation, trace redaction |
| Privacy | optional recognizer-driven redaction / restore across request, response and stream (incremental tool-argument restore) |

**Not yet supported:** OpenAI Responses format `openai-responses`.

## Quick Start

### Install

```bash
npm install llm-protocol
```

Requires Node.js ≥ 20. The current line is 3.x (canonical IR v0.5, native-partition codecs, privacy transform).

### Usage

Call `translate.<source>.<target>(options)`; the returned `Response` is back in the source protocol.

```ts
import { translate } from "llm-protocol";

// OpenAI Chat client -> Anthropic Messages upstream
const response = await translate.chat.messages({
  url: "https://api.anthropic.com/v1/messages", // final upstream URL, used verbatim
  headers: {
    "x-api-key": anthropicApiKey,
    "anthropic-version": "2023-06-01",
  },
  body: {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
  },
  logid: "req-123",
  onComplete: (r) => console.log(r.logid, r.status, r.usage),
});

const chat = await response.json(); // OpenAI Chat response
```

`url` and `headers` are used **verbatim** (no path rewriting or credential movement), so the caller supplies the final, target-shaped headers. Only the body is translated — and the response is translated back to the source protocol.

### Protocol matrix

| Call | Direction | Status |
| --- | --- | --- |
| `translate.messages.messages` | Anthropic Messages → Anthropic Messages | Available |
| `translate.messages.chat` | Anthropic Messages → OpenAI Chat | Available |
| `translate.chat.messages` | OpenAI Chat → Anthropic Messages | Available |
| `translate.chat.chat` | OpenAI Chat → OpenAI Chat | Available |
| `translate.messages.responses` / `translate.chat.responses` | → OpenAI Responses | P1 (unsupported) |
| `translate.responses.*` | OpenAI Responses → … | P1 (unsupported) |

> `messages` = Anthropic Messages, `chat` = OpenAI Chat, `responses` = OpenAI Responses.

Same-protocol calls (`messages.messages`, `chat.chat`) are not byte echoes: they run the full `parse → IR → render` round-trip and report the same fidelity and drop data as cross-protocol calls.

### SSE streaming

Set `stream: true` in the body (or pass `stream: true` as an option); the response body becomes a real-time `ReadableStream` of source-protocol SSE.

```ts
const response = await translate.chat.messages({
  url: "https://api.anthropic.com/v1/messages",
  headers: {
    "x-api-key": anthropicApiKey,
    "anthropic-version": "2023-06-01",
  },
  body: {
    model: "claude-sonnet-4-5",
    stream: true,
    messages: [{ role: "user", content: "Hello" }],
  },
  onComplete: (r) => {
    // canonical events and unified usage, observed before privacy restore
    console.log(r.sseEvents?.length, r.usage);
  },
});

// The body is OpenAI Chat SSE; consume it frame by frame
const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";

for (;;) {
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

### Options

`translate.<source>.<target>(options)` accepts:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string \| URL` | yes | Complete, final upstream URL. Used verbatim — no origin/path/endpoint rewriting. |
| `body` | `unknown` | yes | Source-protocol request body (object, or a JSON string that is parsed first). |
| `headers` | `HeadersInit` | no | Final upstream headers, forwarded verbatim. `content-type: application/json` is added when absent. |
| `model` | `string` | no | Overrides the IR model (otherwise taken from the body). |
| `includeUsage` | `boolean` | no | Best-effort usage request. Rendered as Chat `stream_options.include_usage`; silently dropped where unsupported (e.g. Anthropic). |
| `stream` | `boolean` | no | Explicit streaming override; falls back to the body's `stream` field. |
| `logid` | `string` | no | Correlation id shared by `trace` and `onComplete`; auto-generated when omitted. |
| `onComplete` | `(r: TranslateCompletion) => void` | no | Fires exactly once per call. |
| `onPrivacyComplete` | `(r: PrivacyCompletionReport) => void` | no | Privacy statistics (privacy enabled). |
| `trace` | `(t: TranslationTrace) => void` | no | Diagnostic trace, including fidelity warnings. |
| `fetch` | `typeof fetch` | no | Upstream executor. Defaults to `globalThis.fetch`. |
| `signal` | `AbortSignal` | no | Caller cancellation signal. |
| `timeoutMs` | `number` | no | Upstream timeout in milliseconds. |
| `maxBodyBytes` | `number` | no | Source body size limit in bytes. Default 10 MiB. |
| `keepAliveIntervalMs` | `number` | no | Anthropic keepalive ping interval. Default 15000. |
| `profiles` | `Partial<Record<ApiFormat, ProviderProfile>>` | no | Per-format provider capability overrides. |
| `policies` | `TranslationPolicies` | no | Translation policies (default `DEFAULT_POLICIES`). |
| `cache` | `{ resolvers?, privacySafeResolvers?, key?, namespace? }` | no | Prompt-cache affinity (Anthropic `cache_control` → Chat `prompt_cache_key`). |
| `privacy` | `PrivacyOptions` | no | Privacy recognition / redaction / restore. |

### Fidelity and drops

Every call records what the translation did to the payload. `trace` receives a `TranslationTrace` with `fidelity`, `warnings`, `drops` and — on failures — `failurePhase`:

| Fidelity | Meaning |
| --- | --- |
| `EXACT` | Semantically identical render. |
| `COMPATIBLE` | An explicitly enabled feature was approximated (e.g. `cache_control` → `prompt_cache_key`). |
| `LOSSY` | At least one field was dropped (see `drops`) or a feature adaptation lost information. |
| `UNSUPPORTED` | The target cannot express the construct at all. |

Droppability is decided per field from the `ProviderProfile` capabilities: fields the target can express are adapted, droppable fields are dropped and listed in `trace.drops` (`path`, `cause`, `authorization`), and fields that may not be dropped fail closed — the call rejects with a `TranslationError` (`code: "non_droppable_field"`) instead of losing data. Response-side projection failures surface as a source-protocol error `Response` with `failurePhase` set. Nothing is dropped silently.

### Privacy transform

Recognition is supplied by the caller; the core owns span resolution, deterministic placeholder allocation, replacement and restoration. Redaction runs after parsing and before rendering, and the reverse restore runs on the way back — including incremental restoration while tool arguments stream.

```ts
await translate.chat.messages({
  // url / headers / body as above
  privacy: {
    recognizers: [
      {
        priority: 1,
        recognize(text) {
          return [...text.matchAll(/\d{11}/g)].map((m) => ({
            start: m.index!,
            end: m.index! + m[0].length,
            type: "phone",
          }));
        },
      },
    ],
  },
  onPrivacyComplete: (r) => console.log(r.redacted, r.restored, r.unknownPlaceholders),
});
```

The upstream sees `<private_placeholder_{type}_{N}>` placeholders plus an injected system notice; the caller gets the originals back. `trace` and `onPrivacyComplete` only ever carry counts and warning codes — never raw values, placeholder mappings, credentials or prompt bodies. Defaults are `securityMode: "strict"` (no leakage permitted) and `egress: "policy"`; coverage, templates, HMAC tags and streaming budgets are configurable through `PrivacyOptions`.

### Prompt-cache affinity

Anthropic `cache_control` breakpoints have no Chat equivalent. When the target is OpenAI Chat, the core derives a stable `prompt_cache_key` (affinity, not breakpoint semantics), reports it in `trace.cache`, and only emits it when the target profile declares `capabilities.cache.promptCacheKey` — nothing is sent to providers that would reject the field. Under privacy, resolvers that read raw bodies are disabled unless `cache.allowLegacyCacheResolvers` is set.

### Observability (`onComplete`)

`onComplete` fires exactly once per call — on success, upstream error, validation failure or cancellation — with everything you need for logging, billing and troubleshooting:

```ts
onComplete: (r) => {
  r.logid;            // correlation id
  r.status;           // "completed" | "cancelled" | "errored"
  r.requestBody;      // body actually sent upstream (target protocol)
  r.responseHeaders;  // upstream response headers
  r.upstreamStatus;   // upstream HTTP status
  r.responseBody;     // non-streaming: source-protocol body (restore-before under privacy)
  r.sseEvents;        // streaming: canonical events (restore-before under privacy)
  r.usage;            // { input, output, cacheRead, cacheWrite }
  r.ttft;             // streaming: time-to-first-token in ms
  r.error;            // normalized error when not successful
}
```

## License

MIT
