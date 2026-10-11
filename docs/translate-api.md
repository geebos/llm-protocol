# llm-protocol 统一 `translate` API 破坏性调整技术设计

**文档版本：** v0.1（接口评审稿）
**日期：** 2026-10-10
**适用仓库：** `llm-protocol`
**范围：** 公开入口 `translate` 的破坏性重设计（协议选择、options 化、`onComplete` 观测回调、`logid` 透传）
**目标版本：** `2.0.0`（major，破坏性）

> **依据：** 本次需求评审（2026-10-10）+ 本项目 Canonical IR / codec / pipeline 现状（`docs/tech.md` v0.5、`docs/responses.md` v0.5、`docs/privacy-transform.md` v1.6）。
> **硬约束（不变）：** 一切转换经 Canonical IR 与 `CanonicalStreamEvent`，禁止 A→B 直接映射；任何 LOSSY/UNSUPPORTED 必须产生 `TranslationWarning`（FR-008）；凭据只在 header codec 内作为不透明值搬运；隐私原文与 API Key 禁止进入 trace/report/日志/错误消息（INV-3，`docs/privacy-transform.md`）。

## 文档控制

| **版本** | **日期**   | **说明**                                                                 |
|----------|------------|--------------------------------------------------------------------------|
| v0.1     | 2026-10-10 | 初稿：`translate` 命名空间化、options 化、`onComplete` 观测回调、`logid` 透传；给出类型、示例、迁移与实现影响，末章列出待确认问题。 |
| v0.2     | 2026-10-10 | 确认 Q10：隐私开启时 `onComplete` 观测数据为 **restore 前**（占位符）视图，绝不回传原文。 |
| v0.3     | 2026-10-10 | 明确 `includeUsage` 为 best-effort 提示：不支持的目标协议**静默丢弃**（不产生 warning），作为 FR-008 的显式豁免（无语义数据损失）。 |

## 目录

1. [背景与动机](#1-背景与动机)
2. [范围与非目标](#2-范围与非目标)
3. [接口总览](#3-接口总览)
4. [类型定义](#4-类型定义)
5. [TranslateOptions 字段规范](#5-translateoptions-字段规范)
6. [onComplete 观测回调](#6-oncomplete-观测回调)
7. [统一 Usage 映射](#7-统一-usage-映射)
8. [logid 透传规范](#8-logid-透传规范)
9. [行为语义](#9-行为语义)
10. [示例](#10-示例)
11. [错误模型](#11-错误模型)
12. [迁移指南](#12-迁移指南)
13. [内部实现影响](#13-内部实现影响)
14. [测试与验收](#14-测试与验收)
15. [待确认问题](#15-待确认问题)

---

# 1. 背景与动机

当前公开入口为工厂式：

```ts
const forward = translate({ from: "openai-chat", to: "anthropic-messages", fetch });
const response = await forward(new Request("https://api.anthropic.com/v1/messages", { ... }));
```

存在三个痛点：

1. **协议选择必须写字符串**：`from` / `to` 是运行期字符串，`translate.messages.chat` 这种静态形态更直观、可被类型系统约束，也更贴近「目标协议」这一核心概念。
2. **`Request` 承载了过多职责**：URL（origin 用于拼 endpoint）、headers（需 codec 清洗/加鉴权）、body（JSON）、signal、method 混在一个对象里；调用方往往已经持有结构化 body 和目标 URL，却被迫先构造 `Request`。
3. **缺少统一的请求级观测出口**：调用方要自己做协议解析才能拿到「实际发出的请求体、非流式响应体、流式事件、统一 usage、响应头」，无法直接用于日志、计费与排障。

本次调整把入口改为 **`translate.<source>.<target>(options)`**，把请求数据搬进 `options`，并新增 `onComplete` 观测回调与 `logid` 透传。

# 2. 范围与非目标

**范围内：**

- `translate` 导出形态破坏性变更（命名空间化）。
- options 化：URL / model / include usage / headers / body 全部由 `options` 提供，不再接受 `Request`。
- `onComplete` 观测回调（请求体、非流式响应体、SSE 事件、统一 usage、响应头）。
- `logid` 内部日志追踪透传。

**非目标：**

- 不改 Canonical IR 的核心语义模型；仅新增 `CanonicalRequest.includeUsage`（见 §9.4）。
- 不改 codec 的请求/响应/流式转换逻辑。
- 不改隐私、cache、debug 能力本身；它们作为 options 继续保留。
- 不引入新的 HTTP 客户端抽象；仍以 `fetch` 为唯一出口。

# 3. 接口总览

```ts
import { translate } from "llm-protocol";

await translate.<source>.<target>(options);
```

- **source**（源协议，即客户端/入站协议）：`messages` | `chat` | `responses`
- **target**（目标协议，即上游/出站协议）：`messages` | `chat` | `responses`

协议键到 `ApiFormat` 的映射：

| 协议键        | `ApiFormat`           | 说明                     |
|---------------|------------------------|--------------------------|
| `messages`    | `anthropic-messages`   | Anthropic Messages       |
| `chat`        | `openai-chat`          | OpenAI Chat Completions  |
| `responses`   | `openai-responses`     | OpenAI Responses（P1）   |

组合（共 9 种）：

| 调用形态                        | 语义                          | 现状                     |
|---------------------------------|-------------------------------|--------------------------|
| `translate.messages.messages`   | anthropic → anthropic（直通） | 可用                     |
| `translate.messages.chat`       | anthropic → openai-chat       | 可用                     |
| `translate.messages.responses`  | anthropic → openai-responses  | P1 未实现，调用即失败    |
| `translate.chat.messages`       | openai-chat → anthropic       | 可用                     |
| `translate.chat.chat`           | openai-chat → openai-chat     | 可用                     |
| `translate.chat.responses`      | openai-chat → openai-responses| P1 未实现，调用即失败    |
| `translate.responses.messages`  | openai-responses → anthropic  | P1 未实现，调用即失败    |
| `translate.responses.chat`      | openai-responses → openai-chat| P1 未实现，调用即失败    |
| `translate.responses.responses` | openai-responses → 自身       | P1 未实现，调用即失败    |

- 选择器（`translate.messages` / `translate.messages.chat` 等）是**无状态、可复用**的：可只取一次引用并在多处并发调用。
- `responses` 相关组合在 adapter 落地前，调用返回 `unsupported` 错误（`kind=unsupported`，消息明确「P1 未实现」），与现状一致。
- 单次调用返回 **`Promise<Response>`**（源协议响应；流式为 SSE `Response.body`）。详见 §15-Q1。

# 4. 类型定义

```ts
import type { ApiFormat } from "llm-protocol";
import type { ProviderProfile } from "llm-protocol";
import type { TranslationPolicies } from "llm-protocol";
import type { CanonicalStreamEvent } from "llm-protocol";
import type { CanonicalError, TranslationError } from "llm-protocol";
import type { PrivacyOptions, PrivacyCompletionReport } from "llm-protocol";
import type { DebugSseOptions } from "llm-protocol";

/** 单个 source→target 组合的调用签名：options 进，Response 出。 */
export type TranslateCall<From extends ApiFormat, To extends ApiFormat> = (
  options: TranslateOptions,
) => Promise<Response>;

/** 某 source 下的全部 target 选择器。 */
export type TranslateTargets<From extends ApiFormat> = {
  messages: TranslateCall<From, "anthropic-messages">;
  chat: TranslateCall<From, "openai-chat">;
  responses: TranslateCall<From, "openai-responses">;
};

/** 公开入口。 */
export type TranslateNamespace = {
  messages: TranslateTargets<"anthropic-messages">;
  chat: TranslateTargets<"openai-chat">;
  responses: TranslateTargets<"openai-responses">;
};

export interface TranslateOptions {
  // ---- 请求描述（必选/核心） ----
  /** 完整上游 URL，内部不再做任何 path 拼接、origin 替换或 endpoint 推断。 */
  url: string | URL;
  /** 源协议请求体（JSON 对象，或已序列化的 JSON 字符串）。 */
  body: unknown;
  /** 最终转发给上游的 headers，原样使用（详见 §9.2）。 */
  headers?: HeadersInit;
  /** 覆盖 IR model（对应各协议请求体的 model 字段）。 */
  model?: string;
  /** 覆盖 IR include usage（流式是否请求并回传 usage）。 */
  includeUsage?: boolean;

  // ---- 观测 ----
  /** 内部日志追踪 id；缺省时由内部生成。 */
  logid?: string;
  /** 请求级完成回调，成功/失败/取消都会恰好触发一次。 */
  onComplete?: (result: TranslateCompletion) => void;
  /** 隐私完成回调（隐私开启时）。 */
  onPrivacyComplete?: (report: PrivacyCompletionReport) => void;
  /** 诊断 trace 回调。 */
  trace?: (trace: TranslationTrace) => void;

  // ---- 执行控制 ----
  /** 上游执行器，默认 `globalThis.fetch`。 */
  fetch?: typeof globalThis.fetch;
  /** 调用方取消信号（替代旧 Request.signal）。 */
  signal?: AbortSignal;
  /** 上游超时（ms）。 */
  timeoutMs?: number;
  /** 源请求体大小上限（字节），默认 10 MiB。 */
  maxBodyBytes?: number;
  /** Anthropic 源流空闲 keepalive 间隔（ms）。 */
  keepAliveIntervalMs?: number;

  // ---- 能力与策略 ----
  /** 按格式覆盖 ProviderProfile 能力声明。 */
  profiles?: Partial<Record<ApiFormat, ProviderProfile>>;
  /** 转换策略（附录 A.3）。 */
  policies?: TranslationPolicies;
  /** Prompt-cache 亲和性转换。 */
  cache?: TranslateCacheOptions;
  /** 隐私识别-替换-还原。 */
  privacy?: PrivacyOptions;
  /** 原始 SSE 调试采集。 */
  debug?: DebugSseOptions;
}

export interface TranslateCompletion {
  /** 与 trace / 内部日志关联的追踪 id。 */
  logid: string;
  from: ApiFormat;
  to: ApiFormat;
  /** 完成状态：成功 / 主动取消 / 出错（含校验与上游错误）。 */
  status: "completed" | "cancelled" | "errored";
  /** 实际发出的上游请求体（目标协议，JSON 对象）。未发出时为 undefined。 */
  requestBody?: unknown;
  /** 上游响应头。未收到响应时为 undefined。 */
  responseHeaders?: Headers;
  /** 上游 HTTP 状态码。 */
  upstreamStatus?: number;
  /** 非流式：上游响应体（目标协议，JSON 对象，隐私开启时为 restore 前）；流式为 undefined。 */
  responseBody?: unknown;
  /** 流式：canonical SSE 事件序列（隐私开启时为 restore 前）；非流式为 undefined。 */
  sseEvents?: CanonicalStreamEvent[];
  /** `sseEvents` 是否因缓冲上限被截断。 */
  sseEventsTruncated?: boolean;
  /** 统一 usage（缺省字段按 0 计，见 §7）。 */
  usage?: UnifiedUsage;
  /** 总耗时（ms）。 */
  durationMs: number;
  /** 失败时的规范化错误（成功时 undefined）。 */
  error?: CanonicalError;
}

/** 跨协议统一的用量结构。 */
export interface UnifiedUsage {
  /** 输入 token（inputTokens）。 */
  input: number;
  /** 输出 token（outputTokens）。 */
  output: number;
  /** 缓存读取 token（cacheReadTokens）。 */
  cacheRead: number;
  /** 缓存写入 / 创建 token（cacheCreationTokens）。 */
  cacheWrite: number;
}
```

> `TranslationTrace`、`TranslateCacheOptions` 沿用/内联现状（`cache?: { resolvers?, privacySafeResolvers?, key?, namespace? }`）。

# 5. TranslateOptions 字段规范

| 字段                   | 类型                                   | 必填 | 语义与默认值                                                                                             |
|------------------------|----------------------------------------|------|----------------------------------------------------------------------------------------------------------|
| `url`                  | `string \| URL`                        | 是   | **完整上游 URL**。内部直接 `new Request(url)`，不做 origin 替换、path 拼接、endpoint 推断。               |
| `body`                 | `unknown`                              | 是   | 源协议请求体。对象按 JSON 序列化；字符串按原样解析为 JSON（见 §9.3）。                                   |
| `headers`              | `HeadersInit`                          | 否   | **最终转发 headers**，原样使用（见 §9.2）。缺省 `{}`。                                                    |
| `model`                | `string`                               | 否   | 覆盖 IR `model`。缺省用 body 中的值；两者皆缺 → 校验错误。                                                |
| `includeUsage`         | `boolean`                              | 否   | 覆盖 IR `includeUsage`（见 §9.4）。缺省沿用源 body 解析值。**不支持的目标协议目标侧静默丢弃。** |
| `logid`                | `string`                               | 否   | 内部日志/追踪透传 id（见 §8）。缺省自动生成。                                                            |
| `onComplete`           | `(r: TranslateCompletion) => void`     | 否   | 完成观测回调，按 §6 语义恰好触发一次。                                                                    |
| `onPrivacyComplete`    | `(r: PrivacyCompletionReport) => void` | 否   | 隐私统计回调，语义不变。                                                                                  |
| `trace`                | `(t: TranslationTrace) => void`        | 否   | 诊断 trace，语义不变；新增 `logid` 关联。                                                                 |
| `fetch`                | `typeof fetch`                         | 否   | 默认 `globalThis.fetch`。                                                                                 |
| `signal`               | `AbortSignal`                          | 否   | 调用方取消信号（替代旧 `Request.signal`）。                                                               |
| `timeoutMs`            | `number`                               | 否   | 上游超时。与 `signal` 组合（`AbortSignal.any`）。                                                         |
| `maxBodyBytes`         | `number`                               | 否   | 默认 10 MiB。                                                                                             |
| `keepAliveIntervalMs`  | `number`                               | 否   | 默认 15000；仅当源协议为 Anthropic Messages。                                                             |
| `profiles`             | `Partial<Record<ApiFormat, ProviderProfile>>` | 否 | 能力声明覆盖。                                                                                           |
| `policies`             | `TranslationPolicies`                  | 否   | 默认 `DEFAULT_POLICIES`。                                                                                 |
| `cache`                | `TranslateCacheOptions`                | 否   | 语义不变；仅当 target = openai-chat 生效。                                                                |
| `privacy`              | `PrivacyOptions`                       | 否   | 语义不变；启用时同协议直通关闭并产生相应 warning。                                                        |
| `debug`                | `DebugSseOptions`                      | 否   | 语义不变；与 `onComplete.sseEvents` 并存（见 §9.7）。                                                     |

# 6. onComplete 观测回调

`onComplete` 在**每次调用**结束时触发，且**恰好一次**，覆盖全部路径：

| 场景                     | `status`     | 关键字段                                                         |
|--------------------------|--------------|------------------------------------------------------------------|
| 非流式成功               | `completed`  | `requestBody`、`responseHeaders`、`responseBody`、`usage`        |
| 流式成功（流被读完）     | `completed`  | `requestBody`、`responseHeaders`、`sseEvents`、`usage`           |
| 上游 4xx/5xx             | `completed`  | `requestBody`、`responseHeaders`、`upstreamStatus`、`error`（源协议错误体经反向转换） |
| 调用方取消流             | `cancelled`  | 已发生的 `requestBody` / `responseHeaders` / 部分 `sseEvents`    |
| 校验/隐私/上游/流错误    | `errored`    | 已发生的字段 + `error`（`CanonicalError`）                       |

语义约定：

1. **同步抛出与异步回调并存**：校验类错误（如 `body` 非法 JSON、`url` 非法、超限）会**先抛出/拒绝 Promise**，同时把同一错误通过 `onComplete({ status: "errored" })` 通知一次。调用方二选一即可。
2. **在途数据尽量回填**：上游错误时，若请求已发出，`requestBody` 必填；若响应头已到，`responseHeaders` / `upstreamStatus` 必填。
3. **流式事件缓冲**：`sseEvents` 为 canonical 事件序列（统一表示，见 §15-Q3）。默认上限 10000 条，超出后停止追加并置 `sseEventsTruncated = true`，**不影响**真实 SSE 转发。
4. **回调异常隔离**：`onComplete` 内部抛错被吞掉并写入内部错误日志（不污染调用方结果，不中断流）。
5. **不与 `Response` 竞争**：返回的 `Response` 仍是源协议正文来源；`onComplete` 仅提供观测副本，互不消费。隐私关闭时两者内容一致；隐私开启时 `onComplete` 为 **restore 前**视图，与面向客户端的 `Response` 形成明确分工（见下条）。
6. **隐私：restore 前视图（Q10 已确认）**：隐私开启时，`responseBody` / `sseEvents` 均为隐私还原（restore）**之前**的数据，即含稳定占位符（如 `<private_placeholder_phone_1>`）而不含原文；`requestBody` 本就于替换后实际发出，天然为占位符视图。因此 `TranslateCompletion` 默认即为隐私安全，不含隐私原文。

# 7. 统一 Usage 映射

不同协议的 usage 字段经 `CanonicalUsage` 归一后映射为 `UnifiedUsage`：

| UnifiedUsage | CanonicalUsage 来源          | Anthropic Messages             | OpenAI Chat                | OpenAI Responses        |
|--------------|------------------------------|--------------------------------|----------------------------|-------------------------|
| `input`      | `inputTokens`                | `usage.input_tokens`           | `usage.prompt_tokens`      | `usage.input_tokens`    |
| `output`     | `outputTokens`               | `usage.output_tokens`          | `usage.completion_tokens`  | `usage.output_tokens`   |
| `cacheRead`  | `cacheReadTokens`            | `usage.cache_read_input_tokens`| `usage.prompt_tokens_details.cached_tokens` | `usage.input_tokens_details.cached_tokens` |
| `cacheWrite` | `cacheCreationTokens`        | `usage.cache_creation_input_tokens` | —（Chat 无写入计费字段） | — |

规则：

- 缺失字段按 **0** 计，**不伪造**：`input`/`output` 缺失时为 0，但 `usage` 仅在至少拿到一个 usage 事件时生成。
- `reasoningTokens`、`totalTokens` 等保留在 `CanonicalUsage`，**不进入** `UnifiedUsage`（需完整明细可读 `trace`/SDK 原始响应）。
- 源协议无 usage（如 Chat 流式未开 `include_usage`）时 `usage` 为 `undefined`；`includeUsage: true` 会驱动目标侧请求 usage（§9.4）。

# 8. logid 透传规范

- `options.logid` 未提供时，内部生成 UUID（沿用 `crypto.randomUUID()`）。
- `logid` 贯穿并出现在：`TranslationTrace.logid`、`TranslateCompletion.logid`、`onPrivacyComplete`（会话 id 关联）、内部诊断日志（若有）。
- `logid` **默认不写入上游请求头**，也**不写入响应头**；需要透传时由调用方自行放入 `headers`。
- `logid` 与内部 `traceId` 的关系：`logid` 是调用方可见的关联键；`traceId` 是内部请求级唯一 id。两者缺省相同，若调用方提供 `logid` 则以 `logid` 为准。
- **安全**：`logid` 由调用方提供，禁止在其中放入敏感信息；内部不得将 `logid` 与隐私原文/凭据拼接。
- 是否额外支持「响应头回显 logid（如 `x-logid`）」见 §15-Q6。

# 9. 行为语义

## 9.1 URL

- `url` 视为**完整、最终**的上游地址：不再校验「源协议 path 是否匹配」，也不再由 target endpoint codec 重建 path。
- 因此 `EndpointCodec.matches()` / `fromCanonical()` 在主路径不再被调用（见 §13 清理项）。
- 非法 `url` → 构造期校验错误。

## 9.2 headers

- `options.headers` 是**最终转发 headers**：原样用于上游请求，不运行旧 `renderTargetHeaders` 的源 header 清洗与鉴权注入（鉴权由调用方负责，契合「核心不管理密钥」FR-005B）。
- 序列化 body 后仍需要正确 `content-type`：当 headers 未显式提供 `content-type` 时，补 `application/json`；已提供则尊重调用方值。
- `content-length` 由 `fetch` 按实际 body 计算，调用方无需（也不应）提供。
- 是否仍强制剔除 `host` / `connection` 等逐跳头见 §15-Q4。

## 9.3 body

- `body` 是**源协议**请求体。
- 对象 → `JSON.stringify`；字符串 → 先 `JSON.parse` 再进入 IR（非法 JSON 报错）。是否支持 `Uint8Array` 见 §15-Q5。
- `maxBodyBytes` 对序列化后的字节数生效。

## 9.4 model 与 includeUsage 覆盖

- 解析源 body 得到 `CanonicalRequest` 后：
  - `options.model` 存在 → 覆盖 `canonical.model`。
  - `options.includeUsage` 存在 → 覆盖新增的 `canonical.includeUsage`。
- IR 变更：`CanonicalRequest` 新增 `includeUsage?: boolean`。
- 各协议对 `includeUsage` 的渲染：

| 目标协议             | `includeUsage: true`                                                        | `includeUsage: false`                                            |
|----------------------|-----------------------------------------------------------------------------|------------------------------------------------------------------|
| `openai-chat`        | 合并 `stream_options.include_usage = true`（仅流式）                        | 移除 `stream_options.include_usage`                              |
| `openai-responses`   | 并入 `outputIncludes`（请求 `include: ["usage"]`）                          | 不请求 usage                                                     |
| `anthropic-messages` | 无请求字段；usage 恒在 → **静默丢弃**                                      | 无法抑制 usage；usage 恒在 → **静默丢弃**                        |

- `includeUsage` 只影响**目标侧是否请求/保留 usage**，不改变响应中已存在 usage 的透传。
- **静默丢弃是显式豁免（非静默降级）**：`includeUsage` 是**best-effort 提示**，不是需要忠实搬运的 IR 语义数据。当目标协议不支持该开关（如 Anthropic Messages 恒有 usage、无请求字段）时：
  - 不产生 `TranslationWarning`（与 FR-008「无静默降级」的关系见下）；
  - 目标响应中的 usage 仍按目标协议原样返回（最多是“比预期多”而非“丢失”）。
- **与 FR-008 的关系**：FR-008 禁止的是**语义内容**的静默丢失。`includeUsage` 丢的只是一个可选项开关，不丢任何消息、工具、推理或 usage 数据本身，因此不触发 warning；实现上应在 `includeUsage` 选项文档中标注“best-effort”，避免调用方误以为开关被目标侧严格遵守。
- 源协议不支持解析 include usage 时，源 body 中自然不存在该信息，`options.includeUsage` 仍可覆盖并驱动目标侧（若目标支持）。

## 9.5 流式

- `stream` 仍由源 body 的 `stream: true`（或 Responses 等价字段）判定；本次不新增 `stream` option（见 §15-Q7）。
- 流式返回的 `Response.body` 为**源协议** SSE 字节流，语义与现状一致。
- `onComplete` 在流**结束/取消/出错**时触发。

## 9.6 隐私 / cache / debug

- 三者语义不变，作为 options 继续可用。
- 隐私启用时，同协议直通关闭并产生 `privacy_passthrough_disabled` warning（现状一致）。
- **观测分界（Q10）**：`onComplete` 及其 `responseBody` / `sseEvents` 在隐私还原（restore）**之前**取样，含占位符、不含原文；面向客户端的 `Response` 仍是 restore **之后**（原文）的源协议正文。两者由同一 canonical 流在两个阶段分别取样，互不影响。
- `debug`（原始 SSE 采集）与 `onComplete.sseEvents`（canonical 事件）**并存**：前者保留字节原文（含两端），后者提供统一的 restore 前语义事件。

## 9.7 同协议直通

- `from === to` 且隐私关闭时走快速路径（不解析、不重写），返回上游 `Response`。
- 该路径下 `onComplete` 仍触发：`requestBody` = 原样 body，`responseBody` / `sseEvents` 视是否流式；因未解析 IR，`usage` 尽力从原始响应/SSE 提取（见 §14）。

# 10. 示例

## 10.1 Chat → Messages（非流式，基础）

```ts
import { translate } from "llm-protocol";

const response = await translate.chat.messages({
  url: "https://api.anthropic.com/v1/messages",
  headers: {
    "x-api-key": process.env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "你好" }],
  },
  logid: "lg_7f2c91",
  onComplete: (r) => {
    console.log(r.logid, r.status, r.usage, r.requestBody);
  },
});

const clientJson = await response.json(); // 源协议（Chat）响应体
```

## 10.2 Messages → Chat（流式 + 统一 usage + SSE 事件）

```ts
const response = await translate.messages.chat({
  url: "https://api.openai.com/v1/chat/completions",
  headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  body: {
    model: "gpt-4o",
    stream: true,
    messages: [{ role: "user", content: "写一个快速排序" }],
  },
  includeUsage: true,          // 覆盖 IR：请求上游回传 usage
  logid: "lg_stream_01",
  onComplete: (r) => {
    console.log(r.usage);       // { input, output, cacheRead, cacheWrite }
    console.log(r.sseEvents);   // CanonicalStreamEvent[]
    console.log(r.responseHeaders?.get("x-request-id"));
  },
});

// response.body 是 Anthropic Messages 格式的 SSE
for await (const chunk of response.body!) {
  process.stdout.write(chunk);
}
```

## 10.3 model 覆盖

```ts
await translate.messages.chat({
  url: "https://api.openai.com/v1/chat/completions",
  headers: { authorization: `Bearer ${key}` },
  body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
  model: "gpt-4o-mini", // 覆盖 body.model
});
```

## 10.4 Responses 组合

```ts
// OpenAI Responses → Anthropic Messages
await translate.responses.messages({
  url: "https://api.anthropic.com/v1/messages",
  headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  body: { model: "gpt-5", input: "你好" },
});

// Anthropic Messages → OpenAI Responses
await translate.messages.responses({
  url: "https://api.openai.com/v1/responses",
  headers: { authorization: `Bearer ${key}` },
  body: { model: "claude-sonnet-4-5", max_tokens: 512, messages: [] },
});
```

> `responses` adapter 落地前，上述调用返回 `unsupported` 错误（P1 未实现）。

## 10.5 隐私

```ts
await translate.chat.messages({
  url: "https://api.anthropic.com/v1/messages",
  headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "打 13800138000" }] },
  privacy: { mode: "strict", recognizers: [phoneRecognizer] },
  onPrivacyComplete: (rep) => console.log("redacted:", rep.redacted),
  onComplete: (r) => {
    // restore 前视图：响应体中保留占位符，不含 13800138000 原文
    console.log(JSON.stringify(r.responseBody));
  },
  logid: "lg_privacy_1",
});
```

## 10.6 同协议直通

```ts
const response = await translate.messages.messages({
  url: "https://api.anthropic.com/v1/messages",
  headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  body: { model: "claude-sonnet-4-5", stream: true, messages: [] },
  onComplete: (r) => console.log(r.status, r.sseEvents?.length),
});
```

## 10.7 错误处理

```ts
try {
  const response = await translate.chat.messages({
    url: "https://api.anthropic.com/v1/messages",
    headers,
    body,
    onComplete: (r) => {
      if (r.status !== "completed") logger.warn({ logid: r.logid, error: r.error });
    },
  });
  return response;
} catch (err) {
  // 校验/隐私类错误会 reject；onComplete 也会以 status="errored" 通知一次
  throw err;
}
```

# 11. 错误模型

- 校验类（`url` 非法、`body` 非法 JSON、超限、缺 `model`）→ `TranslationError{ kind: "validation" }`，Promise reject + `onComplete(errored)`。
- 隐私类 → `TranslationError{ kind: "privacy", code }`（现状不变）。
- 上游失败 → `TranslationError{ kind: "upstream" | "timeout" | "cancelled" }`（现状不变）；`onComplete` 携带 `CanonicalError`。
- 上游 4xx/5xx → **不 reject**，返回源协议格式的错误 `Response`（现状不变），`onComplete.status = "completed"` 且带 `error`。
- 未实现的 `responses` 组合 → `TranslationError{ kind: "unsupported" }`。

# 12. 迁移指南

| 旧写法 | 新写法 |
|--------|--------|
| `translate({ from, to, fetch })` | `translate.<source>.<target>`（一次调用完成） |
| `forward(new Request(url, { method, headers, body }))` | `translate.<s>.<t>({ url, headers, body })` |
| `request.signal` | `options.signal` |
| 从 `Request` 读 body 自行解析 | `options.body` 直接传结构化对象 |
| 自行实现观测 | `options.onComplete` |
| 自行传递日志 id | `options.logid` |

**前后对比（Chat → Messages，非流式）：**

```ts
// before
const forward = translate({ from: "openai-chat", to: "anthropic-messages" });
const res = await forward(
  new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }),
  }),
);

// after
const res = await translate.chat.messages({
  url: "https://api.anthropic.com/v1/messages",
  headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] },
});
```

**旧 API 处理：** 直接移除，不提供兼容层（major bump）。如需过渡，可在 `2.x` 提供一个仅转发到新入口的 `translateLegacy` 辅助函数（默认不做，见 §15-Q8）。

# 13. 内部实现影响

| 模块 | 变更 |
|------|------|
| `src/pipeline/translate.ts` | 入口改为 `buildTranslateNamespace()`；`TranslateOptions` 去掉 `from`/`to`；以 `options.url`/`options.body`/`options.headers`/`options.signal` 构造上游 Request；返回 `Promise<Response>`。 |
| `src/pipeline/types.ts` | 更新 `TranslateOptions`、新增 `TranslateCall`/`TranslateTargets`/`TranslateNamespace`/`TranslateCompletion`/`UnifiedUsage`；删除 `ForwardTranslator`（或保留 `getRawSse` 的等价能力到 completion/debug）。 |
| `src/pipeline/completion.ts`（新增） | 完成态聚合：请求体、响应头、非流式响应体、canonical 事件缓冲（带上限）、统一 usage、状态与错误。 |
| `src/pipeline/usage.ts`（新增） | `CanonicalUsage → UnifiedUsage` 映射。 |
| `src/ir/types.ts` | `CanonicalRequest` 新增 `includeUsage?: boolean`。 |
| `src/codecs/openai-chat/request.ts` | 解析/渲染 `includeUsage` ↔ `stream_options.include_usage`（流式）。 |
| `src/codecs/anthropic-messages/request.ts` | `includeUsage` 目标侧静默丢弃（不产生 warning）；解析侧无该字段。 |
| `src/codecs/openai-responses/*`（P1） | `includeUsage` ↔ `outputIncludes`。 |
| `src/codecs/protocol-adapter.ts` | `EndpointCodec` 在主路径不再使用：标记 deprecated 或从 `ProtocolAdapter` 移除（保留待定，见 §15-Q9）。 |
| `src/codecs/*/headers.ts` | `renderTargetHeaders` / `parseCredential` 在 options 路径下不再调用；能力保留供其他入口/测试使用。 |
| `src/pipeline/debug-sse.ts` | 语义不变，与 completion 并存。 |
| `src/index.ts` | 导出 `translate` 命名空间及其类型；移除旧 `ForwardTranslator` 导出（如移除）。 |

# 14. 测试与验收

- **类型**：`translate.messages.chat` 参数与返回类型正确；`translate.responses.*` 调用返回 `unsupported`。
- **options 语义**：`url` 原样使用（不拼接）；`headers` 原样转发；`content-type` 缺省补齐；`body` 对象/字符串均可用。
- **覆盖**：`model` / `includeUsage` 覆盖 IR，且分别落到目标协议请求体（Chat `stream_options.include_usage`、Responses `include`、Anthropic 静默丢弃且**无 warning**）。
- **onComplete**：非流式（成功/上游 4xx）、流式（读完/取消/出错）、直通路径各触发且恰好一次；`status`、`usage`、`sseEvents`、`responseHeaders`、`requestBody` 正确；`onComplete` 抛错不影响主流程。
- **logid**：出现在 `trace` 与 `onComplete`；缺省自动生成；不进入上游/响应头。
- **usage 统一**：三协议 usage 归一后 `{ input, output, cacheRead, cacheWrite }` 正确；缺失按 0；无 usage 时 `undefined`。
- **回归**：现有 292 项单测迁移到新入口后全绿；`compat --offline-only` 18 场景全过；覆盖率不低于基线（statements ≥85%）。
- **安全**：`TranslateCompletion` 序列化不包含凭据与隐私原文。隐私开启时 `onComplete` 恒为 **restore 前**（占位符）视图（Q10 已确认）；需要原文的调用方只能通过面向客户端的 `Response` 获取。

# 15. 待确认问题

以下为落地前需要确认的设计点，当前文档给了默认取舍：

| 编号 | 问题 | 文档默认取舍 |
|------|------|--------------|
| Q1 | 单次调用返回 `Promise<Response>`，还是返回更丰富的 `TranslateResult`（含 requestBody/usage 等）？ | `Promise<Response>`，其余经 `onComplete` |
| Q2 | `onComplete.responseBody` 指上游原始（目标协议）还是客户端最终（源协议）响应体？ | 上游原始（未翻译） |
| Q3 | `onComplete.sseEvents` 用 canonical 统一事件，还是源协议原生 SSE 帧？ | canonical（`CanonicalStreamEvent[]`） |
| Q4 | `headers` 是否彻底原样，还是仍剔除 `host`/`connection` 等逐跳头？ | 原样，仅缺省补 `content-type` |
| Q5 | `body` 是否支持 `Uint8Array` / `ArrayBuffer` 等二进制？ | 暂只支持对象与 JSON 字符串 |
| Q6 | 是否需要把 `logid` 回显到响应头（如 `x-logid`）或透传到上游？ | 都不做，仅内部与回调 |
| Q7 | 是否新增显式 `stream?: boolean` option（而非依赖 body）？ | 不加，沿用 body 判定 |
| Q8 | 是否提供旧 API 兼容层 `translateLegacy`？ | 不提供（major 直接移除） |
| Q9 | `EndpointCodec` 是否从 `ProtocolAdapter` 移除？ | 保留但主路径不调用，标记 deprecated |
| Q10 | 隐私开启时 `onComplete` 观测数据是否应走 restore 前（占位符）还是 restore 后（原文）？ | **已确认：restore 前（占位符视图）** |

---

## 附录 A：命名空间实现草图

```ts
// src/pipeline/namespace.ts
import type { ApiFormat } from "../formats.js";
import { translateCall } from "./translate.js";

const TARGET_KEYS = ["messages", "chat", "responses"] as const;
type Key = (typeof TARGET_KEYS)[number];
const KEY_TO_FORMAT: Record<Key, ApiFormat> = {
  messages: "anthropic-messages",
  chat: "openai-chat",
  responses: "openai-responses",
};

function targetsFor(from: ApiFormat) {
  const build = (to: ApiFormat) => (options: TranslateOptions) =>
    translateCall(from, to, options);
  return {
    messages: build("anthropic-messages"),
    chat: build("openai-chat"),
    responses: build("openai-responses"),
  };
}

export const translate = {
  messages: targetsFor("anthropic-messages"),
  chat: targetsFor("openai-chat"),
  responses: targetsFor("openai-responses"),
};
```
