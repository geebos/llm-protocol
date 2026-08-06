# llm-protocol

**English** | [简体中文](README.zh-CN.md)

**Latest version:** [`v1.0.2`](https://github.com/geebos/llm-protocol/commit/6fb613f)

A clean-room LLM protocol translation core (Phase 1): **Anthropic Messages ↔ OpenAI Chat** — bidirectional request/response/streaming translation that accepts and returns Node.js standard `Request` / `Response` objects, so it can be embedded into any HTTP framework (Fastify / Hono / Express / native Fetch).

- **Spec-driven**: Behavior follows the official OpenAI / Anthropic APIs and official JS SDKs, with no dependency on third-party translation projects.
- **IR-decoupled**: All cross-protocol translation goes through a Canonical IR — no large A→B direct mappings.
- **No silent degradation**: When Thinking, Tools, Usage, etc. cannot be mapped losslessly, they always surface in a `TranslationReport` (warnings / policies / rejection).
- **Full requirement spec**: [`docs/tech.md`](docs/tech.md) (v0.5).

## Features

| Capability | Support |
| --- | --- |
| Protocols | Anthropic Messages ↔ OpenAI Chat (`openai-responses` reserved for P1) |
| Modes | Non-streaming JSON, SSE streaming (real-time `Response.body`, no buffering) |
| Content | system / multi-turn text / images / Tool definitions / Tool calls / Tool results (multi-turn resubmission & parallel calls) |
| Thinking | thinking / redacted_thinking / signature bidirectional mapping, with three policies (reject / drop_with_warning / provider_metadata) |
| State | usage, finish/stop reason, ID, model, reverse error translation |
| Security | opaque credential passthrough, header sanitization, body size limits, timeouts, cancellation propagation, trace redaction |

## Installation

```bash
npm install llm-protocol
```

Requires Node.js ≥ 20 (uses standard Fetch, Web Streams, AbortSignal).

## Quick Start

### 1. Transparent translation factory (main API)

`translate({ from, to })` returns a `Request → Promise<Response>` handler:

```ts
import { translate } from "llm-protocol";

// Create a forwarder from "OpenAI Chat client → Anthropic upstream"
const forwardToAnthropic = translate({
  from: "openai-chat",
  to: "anthropic-messages",
});

// The input must be in the OpenAI Chat protocol (path / headers / body all in the from-protocol)
const openAIRequest = new Request(
  "https://api.anthropic.com/v1/chat/completions", // origin chosen by the caller, points at the target provider
  {
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
    signal: clientRequest.signal,
  },
);

const response = await forwardToAnthropic(openAIRequest);

// The returned Response is back in the OpenAI Chat protocol:
// - Non-streaming: OpenAI JSON
// - Streaming: OpenAI SSE (Response.body is a real-time ReadableStream, parseable by official SDKs)
return response;
```

The target protocol (URL rewriting, auth headers, `anthropic-version`, body translation, reverse response translation) is fully handled inside the factory and never leaks to the caller.

### 2. Use in an HTTP framework

```ts
// Fastify example (NFR-011: protocol core decoupled from the HTTP server)
app.post("/v1/chat/completions", async (request, reply) => {
  const req = new Request(
    `http://upstream-host.example.com${request.url}`,
    { method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: request.raw.signal },
  );
  const response = await forwardToAnthropic(req);
  reply.code(response.status).headers(Object.fromEntries(response.headers)).send(response.body);
});
```

### 3. Options

```ts
translate({
  from: "openai-chat",
  to: "anthropic-messages",

  // Inject an upstream executor (testing / recording / fault injection). Defaults to globalThis.fetch.
  fetch: myFetch,

  // Override a side's ProviderProfile (e.g. declare Chat reasoningField, TH-003)
  profiles: {
    "openai-chat": {
      protocol: "openai-chat",
      capabilities: { tools: true, parallelTools: true, streaming: true, thinking: true, reasoningField: "reasoning_content" },
      defaultHeaders: {},
    },
  },

  // Translation policies (Appendix A.3). Default: drop_with_warning + report on reasoning degradation
  policies: { reasoning: "provider_metadata" },

  // Security (NFR-006)
  maxBodyBytes: 10 * 1024 * 1024, // request body limit, default 10 MiB
  timeoutMs: 30_000,              // upstream timeout; throws TranslationError with kind="timeout"

  // Diagnostics (NFR-005): traceId / durationMs / worst fidelity / warnings; no keys or full prompts
  trace: (t) => console.log(t.traceId, t.fidelity, t.warnings),
});
```

### 4. Same-protocol passthrough

When `from === to`, a fast path is used: no parsing, no body rewriting — original chunks and backpressure are preserved, only cancellation and tracing are applied (FR-006 / 9.11).

```ts
translate({ from: "openai-chat", to: "openai-chat" })(request); // passthrough
```

## Compatibility testing (testkit + compat-runner)

Built-in multi-provider compatibility lab: it builds standard `Request` objects through the public `translate()` handler, calls the upstream, and hands the result to protocol assertions / official SDKs (without bypassing the main API to test lower-level codecs only).

### Running

```bash
# Offline fixture matrix (no real API calls, always run)
npm run compat -- --offline-only

# Full: offline + live smoke (requires configured keys)
npm run compat

# Specific provider / tag / budget
npm run compat -- --provider anthropic-native --tag stream
npm run compat -- --budget 20 --reports-dir ./reports
```

### Configuring providers (`.env`)

```bash
cp .env.example .env
```

| Variable | Description |
| --- | --- |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_TEST_MODEL` | Anthropic native (defaults to official `api.anthropic.com`) |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_TEST_MODEL` | OpenAI native (defaults to official `api.openai.com`) |
| `COMPAT_A_BASE_URL` / `COMPAT_A_API_KEY` / `COMPAT_A_MODEL` | Third-party OpenAI-compatible (baseUrl/model have no default, required) |

Behavioral conventions:

- Keys are read only from environment variables / `.env`; `compat-runner` auto-loads `.env` at startup (shell-exported variables take precedence and are **not** overridden by `.env`).
- If shell variables and `.env` values disagree, a masking warning is printed at startup.
- When no key is configured, live scenarios are marked `skipped`; the offline matrix still runs in full and does not fail the run.
- Keys are redacted (masked) in logs/reports (`maskKey`).

### Reports

Output is written to `reports/` after a run (change with `--reports-dir`):

- `compat.json` — structured results & summary
- `compat.junit.xml` — CI integration
- `compat.md` — Markdown compatibility report

### Test modes (10.4)

| Mode | Description | When |
| --- | --- | --- |
| Fixture Contract | Fixed JSON/SSE assets in `fixtures/` drive the full `translate()` pipeline | Every PR (must run, `--offline-only`) |
| Live Smoke | Real provider text / streaming / two-turn tools / thinking | Daily or manual |
| Budget circuit breaker | `--budget` caps the number of requests, skipping the rest when reached | Cost control |

## Directory structure

```text
llm-protocol/
├── src/                        # protocol translation core
│   ├── formats.ts              # ApiFormat enum (FR-001)
│   ├── errors.ts               # unified error model (FR-011)
│   ├── ir/                     # Canonical IR (pure types)
│   │   ├── types.ts            #   request / content part / message / tool
│   │   ├── response.ts         #   response
│   │   ├── finish-reason.ts    #   unified stop reason (FR-009)
│   │   ├── usage.ts            #   unified usage (FR-010)
│   │   ├── fidelity.ts         #   EXACT/COMPATIBLE/LOSSY/UNSUPPORTED (FR-008)
│   │   └── policies.ts         #   translation policies (Appendix A.3)
│   ├── capabilities/           # ProviderProfile (FR-007)
│   ├── codecs/
│   │   ├── protocol-adapter.ts # codec abstraction (endpoint/header/request/response/error/stream)
│   │   ├── headers.ts          # header sanitization / allowlist
│   │   ├── registry.ts         # adapter registry
│   │   ├── anthropic-messages/ # Messages codec
│   │   └── openai-chat/        # Chat codec
│   ├── streams/                # SSE state machine (M2)
│   │   ├── types.ts            #   CanonicalStreamEvent (7.1)
│   │   ├── sse-parser.ts       #   byte-level SSE frame parsing / encoding (SR-001)
│   │   ├── validator.ts        #   event invariant validation (SR-002)
│   │   ├── anthropic/          #   Messages SSE ↔ canonical
│   │   └── openai/             #   Chat SSE ↔ canonical
│   ├── pipeline/
│   │   ├── types.ts            # TranslateOptions / TranslationTrace
│   │   └── translate.ts        # transparent translation factory (main API)
│   └── index.ts                # public exports
├── testkit/                    # multi-provider test framework (M5)
│   ├── types.ts                # ProviderConfig / Scenario / RunResult
│   ├── providers.ts            # config parsing / three built-in provider types / key redaction
│   ├── fixtures.ts             # fixture loading & mock upstream executor
│   ├── assertions.ts           # semantic assertions (10.5)
│   ├── runner.ts               # matrix executor (capability gating / budget / live two rounds)
│   ├── scenarios/              # offline fixture + live smoke scenarios
│   └── reporters/              # JSON / JUnit / Markdown reports
├── apps/compat-runner/         # compatibility test CLI (M5)
├── fixtures/                   # offline fixture assets (requests/responses/streams)
└── tests/                      # vitest unit / integration / SDK smoke / hardening / testkit tests
```

## Design principles

- **Transparency**: Callers only see the `from` protocol; target-protocol details (endpoint, auth headers, `anthropic-version`) are handled internally by the translator.
- **Credential safety**: Keys travel as opaque values inside the header codec and never enter the IR, trace, or reports.
- **Independent SSE**: Non-streaming codecs are separated from stream codecs; streaming must go through the canonical event state machine (start/delta/end pairing, single terminal).
- **Capability-driven**: Field mapping is decided by `ProviderProfile` declarations, never by guessing model names.
- **Report-driven**: Every LOSSY / UNSUPPORTED decision lands in a `TranslationReport` — nothing is silently dropped.

## Development commands

```bash
npm install
npm run typecheck       # TS strict (src)
npm run typecheck:all   # full type check (src + testkit + apps)
npm test                # vitest, 136 test cases
npm run test:coverage   # coverage (statement 89%+)
npm run build           # build dist/
npm run compat -- --offline-only   # offline compatibility matrix
```

## Milestone status

M0–M6 all complete:

- **M0** Canonical IR / fidelity / error / capability model
- **M1** Messages ↔ Chat non-streaming codec + transparent factory
- **M2** SSE streaming state machine (byte-level parsing, event validation, real-time `Response.body`)
- **M3** Full Tool flow (parallel calls, multi-turn resubmission, ID generation & reporting)
- **M4** Thinking policies (reject / drop_with_warning / provider_metadata)
- **M5** Provider testkit + compat-runner CLI + fixture assets
- **M6** Hardening (body limits, timeouts, malformed tolerance, observability, performance benchmarks)

Validated against real relay providers: full live matrix passed across 30 scenarios (text / streaming / two-turn tools / thinking, bidirectional).

**Remaining items**: `openai-responses` adapter (P1); live provider testing recommended against official Anthropic / OpenAI and several third parties; branch coverage 73% (statement coverage already exceeds the 85% target).
