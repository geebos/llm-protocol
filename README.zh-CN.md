# llm-protocol

[English](README.md) | **简体中文**

独立实现的 LLM 协议转换内核：**Anthropic Messages ↔ OpenAI Chat** 双向请求/响应/流式转换。用普通 options（`url` / `headers` / `body`）描述上游调用，返回源协议的标准 `Response`，可直接嵌入任何 HTTP 框架。

## 特性

| 能力 | 支持 |
| --- | --- |
| 协议 | Anthropic Messages ↔ OpenAI Chat |
| 模式 | 非流式 JSON、SSE 流式 |
| 内容 | system / 多轮文本 / 图片 / Tool 定义 / Tool 调用 / Tool 结果 / 多轮回注 / 并行调用 |
| Thinking | thinking / redacted_thinking / signature 双向映射，三策略：reject / drop_with_warning / provider_metadata |
| 状态 | usage（统一结构）、finish/stop reason、ID、model、错误反向转换 |
| 可观测 | 每次调用的 `onComplete`（请求体、响应体、canonical SSE 事件、统一 usage）、`logid`、诊断 trace |
| 安全 | 凭据由调用方持有、最终 headers 原样转发、body 大小限制、超时、取消传播、trace 脱敏 |

**暂不支持**：OpenAI Responses 格式 `openai-responses`。

## 快速开始

### 安装

```bash
npm install llm-protocol
```

Node.js ≥ 20。

2.x 系列目前发布在 `beta` dist-tag 下：

```bash
npm install llm-protocol@beta   # 或：llm-protocol@2.0.0-beta.0
```

### 使用示例

调用 `translate.<source>.<target>(options)`，返回的 `Response` 已恢复为源协议。

```ts
import { translate } from "llm-protocol";

// OpenAI Chat 客户端 -> Anthropic Messages 上游
const response = await translate.chat.messages({
  url: "https://api.anthropic.com/v1/messages", // 最终上游地址，原样使用
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

const chat = await response.json(); // OpenAI Chat 响应
```

`url` 与 `headers` **原样使用**（不做路径改写或凭据搬运），因此由调用方提供最终的、目标协议形态的 headers。只有 body 会被转换，响应再反向转换回源协议。

### 协议矩阵

| 调用 | 方向 | 状态 |
| --- | --- | --- |
| `translate.messages.messages` | Anthropic Messages → Anthropic Messages | 可用 |
| `translate.messages.chat` | Anthropic Messages → OpenAI Chat | 可用 |
| `translate.chat.messages` | OpenAI Chat → Anthropic Messages | 可用 |
| `translate.chat.chat` | OpenAI Chat → OpenAI Chat | 可用 |
| `translate.messages.responses` / `translate.chat.responses` | → OpenAI Responses | P1（未支持） |
| `translate.responses.*` | OpenAI Responses → … | P1（未支持） |

> `messages` = Anthropic Messages，`chat` = OpenAI Chat，`responses` = OpenAI Responses。

### SSE 流式示例

在 body 中设置 `stream: true`（或传入 option `stream: true`），响应 body 即为实时 `ReadableStream`（源协议 SSE）。

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
    // canonical 事件与统一 usage，均为隐私还原前视图
    console.log(r.sseEvents?.length, r.usage);
  },
});

// 响应 body 为 OpenAI Chat SSE，逐帧消费
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

### options 字段说明

`translate.<source>.<target>(options)` 支持以下字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | `string \| URL` | 是 | 完整、最终的上游地址。**原样使用**，不做 origin/path/endpoint 改写。 |
| `body` | `unknown` | 是 | 源协议请求体（对象，或先解析的 JSON 字符串）。 |
| `headers` | `HeadersInit` | 否 | 最终转发给上游的 headers，原样使用；缺省时补 `content-type: application/json`。 |
| `model` | `string` | 否 | 覆盖 IR `model`（否则取 body 中的值）。 |
| `includeUsage` | `boolean` | 否 | best-effort 提示：渲染为 Chat `stream_options.include_usage`；不支持的目标（如 Anthropic）静默丢弃。 |
| `stream` | `boolean` | 否 | 显式覆盖流式判定；缺省回退到 body 的 `stream` 字段。 |
| `logid` | `string` | 否 | 关联 id，`trace` 与 `onComplete` 共用；缺省自动生成。 |
| `onComplete` | `(r: TranslateCompletion) => void` | 否 | 每次调用恰好触发一次。 |
| `onPrivacyComplete` | `(r: PrivacyCompletionReport) => void` | 否 | 隐私统计（启用隐私时）。 |
| `trace` | `(t: TranslationTrace) => void` | 否 | 诊断 trace，含 fidelity warnings。 |
| `fetch` | `typeof fetch` | 否 | 上游执行器，默认 `globalThis.fetch`。 |
| `signal` | `AbortSignal` | 否 | 调用方取消信号。 |
| `timeoutMs` | `number` | 否 | 上游超时（毫秒）。 |
| `maxBodyBytes` | `number` | 否 | 源请求体大小上限（字节），默认 10 MiB。 |
| `keepAliveIntervalMs` | `number` | 否 | Anthropic 空闲 keepalive ping 间隔，默认 15000。 |
| `profiles` | `Partial<Record<ApiFormat, ProviderProfile>>` | 否 | 按格式覆盖 ProviderProfile 能力声明。 |
| `policies` | `TranslationPolicies` | 否 | 转换策略（默认 `DEFAULT_POLICIES`）。 |
| `cache` | `{ resolvers?, privacySafeResolvers?, key?, namespace? }` | 否 | Prompt-cache 亲和性（Anthropic `cache_control` → Chat `prompt_cache_key`）。 |
| `privacy` | `PrivacyOptions` | 否 | 隐私识别 / 替换 / 还原。 |

### 可观测（`onComplete`）

`onComplete` 在每次调用结束时**恰好触发一次**——成功、上游错误、校验失败或取消都会触发——提供日志、计费与排障所需的全部数据：

```ts
onComplete: (r) => {
  r.logid;            // 关联 id
  r.status;           // "completed" | "cancelled" | "errored"
  r.requestBody;      // 实际发出的上游请求体（目标协议）
  r.responseHeaders;  // 上游响应头
  r.upstreamStatus;   // 上游 HTTP 状态码
  r.responseBody;     // 非流式：源协议响应体（隐私下为 restore 前视图）
  r.sseEvents;        // 流式：canonical 事件（隐私下为 restore 前视图）
  r.usage;            // { input, output, cacheRead, cacheWrite }
  r.ttft;             // 流式：首 token 耗时（ms）
  r.error;            // 非成功时的规范化错误
}
```

## 证书

MIT
