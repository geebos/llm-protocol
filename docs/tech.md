# AI 协议转换核心：第一阶段需求规格说明书

> Node.js / TypeScript · Canonical IR · Tool · Thinking · SSE · Multi-Provider Test

| 文档属性 | 内容 |
| --- | --- |
| 项目名称 | llm-protocol |
| 文档版本 | v0.5（仓库结构改为单仓） |
| 文档日期 | 2026-08-07 |
| 阶段范围 | Phase 1：Anthropic Messages ↔ OpenAI Chat；Responses 预留/扩展 |
| 状态 | 供架构评审与任务拆分 |
| 实现原则 | 参考 rosetta-llm 架构，依据官方协议独立实现 |

> **核心目标：** 建立自有、可持续演进的协议转换内核，并用真实 Provider 调用矩阵验证兼容性。

## 文档控制

| **版本** | **日期**   | **说明**                                                       |
|----------|------------|----------------------------------------------------------------|
| v0.1     | 2026-08-06 | 第一阶段需求基线：转换核心、SSE 状态机、多 Provider 测试框架。 |
| v0.2     | 2026-08-07 | 将主 API 调整为面向请求转发的透明转换工厂；输入输出保持客户端协议。 |
| v0.3     | 2026-08-07 | 主 API 输入输出统一为 Node.js 内置 WHATWG `Request` / `Response`；SSE 通过 `Response.body` 原生流式返回。 |
| v0.4     | 2026-08-07 | 修正透明请求契约：输入 Request 的 path、headers、body 全部采用 `from` 协议；URL origin 表示目标 Provider，转换器内部完成 endpoint、鉴权头、协议头、body 及响应的双向转换。 |
| v0.5     | 2026-08-07 | 项目名定为 llm-protocol；仓库结构由 monorepo（packages/）调整为单仓结构，移除独立包的命名与隔离。 |

## 目录

1. [背景与目标](#1-背景与目标)
2. [范围与边界](#2-范围与边界)
3. [设计原则与参考基线](#3-设计原则与参考基线)
4. [总体架构](#4-总体架构)
5. [协议与能力范围](#5-协议与能力范围)
6. [转换核心功能需求](#6-转换核心功能需求)
7. [SSE 与流式状态机需求](#7-sse-与流式状态机需求)
8. [Tool 与 Thinking 需求](#8-tool-与-thinking-需求)
9. [Core API 设计要求](#9-core-api-设计要求)
10. [多 Provider 测试框架](#10-多-provider-测试框架)
11. [测试用例与验收矩阵](#11-测试用例与验收矩阵)
12. [非功能与安全要求](#12-非功能与安全要求)
13. [交付物与里程碑](#13-交付物与里程碑)
14. [第一阶段验收标准](#14-第一阶段验收标准)
15. [风险与缓解措施](#15-风险与缓解措施)
16. [附录 A：数据模型草案](#附录-a-数据模型草案)
17. [附录 B：参考资料](#附录-b-参考资料)

# 1. 背景与目标
## 1.1 背景

现有 Agent Gateway 已负责用户鉴权、租户、额度、模型路由和上游凭据管理。新的协议转换模块不承担业务网关职责，而是专注于不同 LLM API 之间的请求、响应和流式事件转换。

rosetta-llm 提供了清晰的骨架：协议 codec、Canonical IR、stream codec、pipeline 与 upstream 分层，并声明支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 三类端点及流式转换。[R1][R2] 本项目将借鉴其分层思想，但以官方 API 规范和官方 SDK 行为作为最终标准，采用 Node.js/TypeScript 独立实现。

## 1.2 第一阶段目标

- 交付可嵌入、可测试、与 HTTP Server 解耦的 Node.js/TypeScript 协议转换核心。
- 提供面向请求转发场景的透明转换工厂：调用方提交客户端协议请求，核心转换为上游协议并调用 executor，再将上游响应转换回客户端协议。
- 完成 Anthropic Messages 与 OpenAI Chat Completions 的双向请求/响应转换。
- 建立统一流式事件 IR，覆盖文本、工具调用、thinking/reasoning、usage、stop reason 和错误事件。
- 建立多 Provider 实际调用测试框架，通过“转换后的接口”调用真实上游，验证协议和客户端兼容性。
- 将兼容性问题沉淀为 fixtures 和永久回归测试，而不是依赖单一开源项目的更新节奏。

> **成功定义：** 同一套 Anthropic/OpenAI HTTP 请求可通过 `translate({ from, to })` 创建的 `Request → Promise<Response>` handler 调用不同协议的上游；转换器输入为 Node.js 标准 `Request`，输出为标准 `Response`，客户端可见 body 始终保持 `from` 协议；SSE 通过 `Response.body` 实时传输并可被官方 SDK 正确解析；Tool 和 Thinking 在目标协议能力允许时保持语义连续，在无法无损转换时必须显式报告。

# 2. 范围与边界
## 2.1 Phase 1 必做范围（P0）

| **范围**     | **要求**                                                                                    |
|--------------|---------------------------------------------------------------------------------------------|
| **协议**     | Anthropic Messages `/v1/messages` ↔ OpenAI Chat Completions `/v1/chat/completions`。    |
| **模式**     | 非流式与 SSE 流式。                                                                         |
| **内容**     | system、user/assistant 多轮文本、基础图片输入（能力允许时）、工具定义、工具调用、工具结果。 |
| **Thinking** | IR 必须支持 thinking/reasoning；按 Provider 能力策略映射、透传或显式降级，禁止静默丢失。    |
| **状态**     | usage、finish/stop reason、request/response ID、model、错误。                               |
| **测试**     | 离线 fixtures + 至少三类真实 Provider 的调用矩阵。                                          |

## 2.2 Phase 1 扩展范围（P1）

- OpenAI Responses `/v1/responses` adapter：优先实现 reasoning 与 function call 的 IR 映射。
- 并行工具调用、细粒度 tool arguments streaming。
- 结构化输出、prompt caching 元数据、provider-specific extension 映射。
- 更多多模态输入类型。

## 2.3 明确不在范围内

- 用户鉴权、租户、计费、额度、API Key 管理和模型路由。
- 生产级公共 HTTP Server、管理后台、模型列表聚合。
- Provider 账号池、OAuth 登录、负载均衡与故障转移。
- 执行 Tool 本身；核心只转换 tool definition、tool call 和 tool result。
- 保证所有 Provider 私有字段百分之百无损；无法映射的字段必须进入扩展区或转换报告。

# 3. 设计原则与参考基线

| **原则**            | **说明**                                                                                             |
|---------------------|------------------------------------------------------------------------------------------------------|
| **官方规范优先**    | 协议定义和事件顺序以 OpenAI、Anthropic 官方文档及官方 SDK 实际解析行为为最高依据。[R5][R6][R7] |
| **IR 解耦**         | 所有跨协议转换经 Canonical IR，不编写大量 A→B 的直接映射。                                           |
| **流式独立**        | 非流式 codec 与 stream codec 独立，SSE 必须通过 canonical event state machine。                      |
| **不静默降级**      | Thinking、Tool、usage 等无法无损映射时，必须返回 TranslationReport。                                 |
| **能力驱动**        | 通过 ProviderProfile/CapabilityMatrix 决定字段映射，不依赖模型名猜测。                               |
| **Clean-room 实现** | rosetta-llm 用作架构参考；New API/Sub2API 用作案例雷达；不直接翻译许可证不明确或强 copyleft 的代码。 |
| **Fixture 资产化**  | 每个上游修复先转化为最小复现 fixture，再独立修复。                                                   |

## 3.1 参考项目角色

| **来源**         | **本项目中的角色**                                                                                                                     |
|------------------|----------------------------------------------------------------------------------------------------------------------------------------|
| **rosetta-llm**  | 第一版分层骨架：codecs / IR / stream_codecs / pipeline。仓库当前结构明确，但提交与测试规模较小，因此不作为唯一正确性来源。[R1][R2] |
| **CLIProxyAPI**  | 成熟协议转换、流式、工具调用和多协议兼容的实现与测试参考；其文档明确提供 translator/executor SDK 能力。[R3]                          |
| **Sub2API**      | 真实生产问题、断流、SDK 兼容、reasoning、usage 等问题雷达。[R4]                                                                      |
| **New API**      | 广泛 Provider、新协议字段和社区兼容问题雷达。[R4]                                                                                    |
| **官方 API/SDK** | 协议行为的最终裁判。                                                                                                                   |

# 4. 总体架构

```text
┌──────────────────────────────────────────┐
│             Your Agent Gateway           │
│ auth / tenant / quota / routing / keys   │
└────────────────────┬─────────────────────┘
                     │ Node Request（source protocol）
                     ▼
┌──────────────────────────────────────────┐
│       translate({ from, to })            │
│        Request → Promise<Response>       │
│                                          │
│ 1. parse source request                  │
│ 2. render target request                 │
│ 3. execute target upstream               │
│ 4. parse target response/SSE             │
│ 5. render source response/SSE            │
└────────────────────┬─────────────────────┘
                     │ Node Request（target protocol）
                     ▼
┌──────────────────────────────────────────┐
│           Target Provider                │
│ origin selected by Gateway; protocol     │
│ details generated inside translator      │
└────────────────────┬─────────────────────┘
                     │
                     ▼
       OpenAI / Anthropic / Compatible

对调用方的可见语义：

Node `Request` → `translate(...)` → Node `Response`

`Response.body` 为 source 协议 JSON 或 source 协议 SSE；流式场景不会缓冲完整响应。

目标协议仅存在于工厂函数内部，不泄漏到 Gateway 路由处理代码。
```

## 4.1 推荐仓库结构

llm-protocol 采用单仓（single-repo）结构，核心、测试框架、可选 sidecar 与 fixtures 同仓组织，不拆分独立 package：

```text
llm-protocol/
├── src/                            # 协议转换核心
│   ├── ir/
│   ├── codecs/
│   │   ├── anthropic-messages/
│   │   ├── openai-chat/
│   │   └── openai-responses/       # P1
│   ├── streams/
│   ├── capabilities/
│   ├── errors/
│   └── pipeline/
├── testkit/                        # 多 Provider 测试框架
│   ├── providers/
│   ├── scenarios/
│   ├── assertions/
│   └── reporters/
├── proxy/                          # 可选内部 sidecar
│   ├── handler.ts
│   └── upstream-fetch.ts
├── fixtures/                       # 离线 fixture 资产
│   ├── requests/
│   ├── responses/
│   ├── streams/
│   └── regressions/
└── apps/
    └── compat-runner/              # 兼容性测试 CLI
```

## 4.2 关键边界

| **模块**               | **负责**                                          | **不负责**                      |
|------------------------|---------------------------------------------------|---------------------------------|
| src/（核心）           | 透明转发工厂、解析、IR、渲染、流状态机、能力判断、转换报告 | HTTP 监听、鉴权、业务路由、密钥存储 |
| testkit/               | Provider 配置、真实调用、断言、报告、成本控制     | 生产流量转发                    |
| proxy/（可选）         | 将核心接入内部 HTTP sidecar、调用上游、pipe SSE   | 用户鉴权和业务路由              |
| Agent Gateway          | 鉴权、路由、上游凭据、配额、审计                  | 协议细节转换                    |

# 5. 协议与能力范围
## 5.1 支持矩阵

| **能力**    | **Anthropic Messages**               | **OpenAI Chat**                | **Phase 1 策略**               |
|-------------|--------------------------------------|--------------------------------|--------------------------------|
| 文本        | content block                        | message content                | P0 双向                        |
| System      | 顶层 system                          | system/developer message       | P0，保留顺序与优先级说明       |
| Tool 定义   | tools + input_schema                 | tools.function.parameters      | P0 双向                        |
| Tool Call   | tool_use                             | assistant.tool_calls           | P0 双向                        |
| Tool Result | tool_result                          | role=tool                      | P0 双向                        |
| 并行 Tool   | 多个 tool_use                        | 多个 tool_calls                | P1；IR 从 P0 起支持            |
| Thinking    | thinking/redacted thinking/signature | 无统一标准；部分 Provider 扩展 | P0 IR + 能力策略，禁止静默丢失 |
| SSE         | 命名 event + JSON data               | data-only chunks + [DONE]    | P0 双向状态机                  |
| Usage       | input/output tokens 等               | prompt/completion tokens 等    | P0 统一字段 + provider details |
| Stop Reason | end_turn/tool_use/max_tokens 等      | stop/tool_calls/length 等      | P0 显式映射                    |

## 5.2 转换保真等级

| **等级**        | **定义**                 | **行为**                               |
|-----------------|--------------------------|----------------------------------------|
| **EXACT**       | 目标协议有等价表示       | 直接映射；无 warning。                 |
| **COMPATIBLE**  | 语义可保持，但结构不同   | 映射并记录 info。                      |
| **LOSSY**       | 目标协议无法表示全部信息 | 按策略处理并生成 warning；默认不静默。 |
| **UNSUPPORTED** | 无法安全或正确转换       | 抛出 typed error 或根据策略拒绝请求。  |

# 6. 转换核心功能需求

| **ID** | **优先级** | **名称**              | **需求**                                                                                                         | **验收**                                               |
|--------|------------|-----------------------|------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------|
| FR-001 | P0         | 协议标识              | 定义 `anthropic_messages`、`openai_chat`、`openai_responses`（P1）格式枚举，不使用模糊字符串。             | 单测覆盖所有合法/非法格式。                            |
| FR-002 | P0         | Canonical Request IR  | 统一表示 model、messages、system、generation、tools、tool choice、thinking、metadata。                           | Anthropic/Chat round-trip 语义不变。                   |
| FR-003 | P0         | Canonical Response IR | 统一表示 content blocks、tool calls、reasoning、usage、finish reason、IDs。                                      | 非流式双向转换通过 golden fixtures。                   |
| FR-004 | P0         | Request Codec         | 每个协议实现 parseRequest/renderRequest；未识别字段进入 extensions。                                             | 无字段静默覆盖；验证失败返回路径明确的错误。           |
| FR-005 | P0         | Response Codec        | 每个协议实现 parseResponse/renderResponse。                                                                      | 官方 SDK 可解析输出。                                  |
| FR-005A | P0        | 透明转换工厂          | 提供 `translate(options)` 工厂，返回可直接用于请求转发的 handler；handler 输入为 Node.js 标准 `Request`，输出为标准 `Response`，HTTP body 语义保持 `from` 协议。        | OpenAI 请求经 Anthropic 上游调用后返回 OpenAI 响应/SSE。 |
| FR-005B | P0        | Upstream Executor     | 上游 HTTP 调用由调用方注入 `execute`；核心不得自行管理 API Key、URL 路由或租户。                                  | Gateway 可为每次调用动态注入 URL、headers、signal。    |
| FR-005C | P0        | 响应反向转换          | 工厂必须自动完成 `from → to` 请求转换和 `to → from` 响应转换；调用方不需要手动调用两个转换函数。                  | 普通响应和 SSE 均通过单一 handler 完成闭环。           |
| FR-005D | P0        | 类型推导              | 主 API 固定为 `Request -> Promise<Response>`；`from/to/stream` 用于选择 codec 与运行时校验。`stream=true` 时 `Response.body` 必须是实时 SSE `ReadableStream`。 | 编译期错误能拦截协议与 stream 类型误用。               |
| FR-006 | P0         | Passthrough           | source=target 且无需策略改写时允许 fast path。                                                                   | 请求和响应主体保持等价，报告标记 passthrough。         |
| FR-007 | P0         | Capability Matrix     | ProviderProfile 显式声明 tools、thinking、stream、parallel tools、reasoning field 等。                           | 转换决策可追踪，不通过 model name 猜测。               |
| FR-008 | P0         | Translation Report    | 返回 fidelity、warnings、dropped fields、generated IDs、applied strategies。                                     | 任何 LOSSY 转换都有报告条目。                          |
| FR-009 | P0         | Stop Reason           | 统一到 `end_turn`、`tool_call`、`max_tokens`、`stop_sequence`、`content_filter/refusal`、`unknown`。 | 映射表和未知值均有测试。                               |
| FR-010 | P0         | Usage                 | 统一 input/output/total/cache/reasoning tokens，保留 providerDetails。                                           | 缺失值不伪造；流式最终 usage 可累计。                  |
| FR-011 | P0         | 错误模型              | 统一 validation、upstream、rate_limit、timeout、cancelled、stream_protocol、unsupported。                        | 保留 status、provider code、request id；敏感字段脱敏。 |
| FR-012 | P1         | Responses Adapter     | 实现 Responses request/response/stream 映射。                                                                    | 通过 Responses 官方 SDK smoke tests。                  |

# 7. SSE 与流式状态机需求

Anthropic 官方流规范要求消息按 `message_start`、content block start/delta/stop、`message_delta`、`message_stop` 的顺序输出，并允许 ping、流内 error 和未来新增的未知事件。[R6] 因此禁止用“逐 JSON chunk 改字段”的无状态实现。

## 7.1 Canonical Stream Event

```ts
type CanonicalStreamEvent =
  | { type: "message_start"; id?: string; model?: string }
  | { type: "text_start"; index: number }
  | { type: "text_delta"; index: number; text: string }
  | { type: "text_end"; index: number }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_arguments_delta"; index: number; partialJson: string }
  | { type: "tool_end"; index: number }
  | { type: "reasoning_start"; index: number; metadata?: unknown }
  | { type: "reasoning_delta"; index: number; text?: string; opaque?: string }
  | { type: "reasoning_end"; index: number; metadata?: unknown }
  | { type: "usage"; usage: CanonicalUsage }
  | { type: "message_end"; finishReason?: CanonicalFinishReason }
  | { type: "error"; error: CanonicalError }
  | { type: "unknown"; sourceType: string; raw: unknown };
```

| **ID**     | **主题**   | **要求**                                                                              |
|------------|------------|---------------------------------------------------------------------------------------|
| **SR-001** | 字节级解析 | 必须处理 UTF-8 字符跨 chunk、JSON 跨 chunk、SSE 多行 data、CRLF/LF、空行和注释。      |
| **SR-002** | 事件顺序   | Emitter 必须保证 start/delta/end 配对，message_end 只出现一次。                       |
| **SR-003** | Tool 参数  | partial arguments 按 tool index/id 累积；结束时必须形成合法 JSON 或产生明确错误。     |
| **SR-004** | Thinking   | 支持 thinking delta、signature/opaque metadata 的开始、增量和结束事件。               |
| **SR-005** | 未知事件   | 未知事件不得导致进程崩溃；按 ProviderProfile 选择忽略、透传扩展或 warning。           |
| **SR-006** | 流内错误   | HTTP 200 后出现的 SSE error 必须转成目标协议可识别的 error 事件或安全终止。           |
| **SR-007** | 背压       | 基于 Web Streams/AsyncIterable 逐事件处理，不缓存完整响应。                           |
| **SR-008** | 取消       | 下游 AbortSignal 必须传递到 parser、transformer 和上游 fetch。                        |
| **SR-009** | 首包       | 转换器不得等待完整 content block 才输出文本；tool JSON 是否细粒度输出由能力策略决定。 |
| **SR-010** | Usage      | 支持末尾 usage 和累计 usage；不能重复计数。                                           |

## 7.2 流式不变量

- `message_start` 必须先于任何内容事件；`message_end/message_stop` 必须是最后一个正常业务事件。
- 每个 content/tool/reasoning block 的 start、delta、end 必须使用一致的 index。
- 同一 tool call 的 ID 和 name 在开始后不可变化。
- 客户端取消后不再发出业务 delta，并尽快中止上游连接。
- 转换器不得伪造 Provider 未返回的 thinking 内容、usage 或 stop reason。

# 8. Tool 与 Thinking 需求
## 8.1 Tool Calling

| **ID**     | **需求**                                                                                                                     | **验收**                                         |
|------------|------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------|
| **TR-001** | Tool schema 在 Anthropic `input_schema` 与 OpenAI JSON Schema `parameters` 间转换，保留 description 与 strict/扩展字段。 | echo/add 等确定性工具可被目标官方 SDK 正确识别。 |
| **TR-002** | Tool call ID 必须稳定；缺失 ID 时生成可追踪 ID，并记录到 TranslationReport。                                                 | 多轮 tool result 可正确关联原调用。              |
| **TR-003** | 支持 assistant 同时输出文本与 tool call。                                                                                    | 输出内容顺序符合目标协议。                       |
| **TR-004** | Tool result 支持文本和结构化内容；错误结果保留 is_error 语义。                                                               | 工具失败场景不被转换为普通成功文本。             |
| **TR-005** | 并行 tool calls 在 IR 中原生支持；目标不支持时按策略拒绝或串行降级并 warning。                                               | 至少一个双 tool fixture。                        |

## 8.2 Thinking / Reasoning

> **边界：** 测试 Thinking 时只验证协议可见的 thinking summary、reasoning item、signature 或 encrypted/opaque metadata 的存在和连续性；不要求、也不尝试提取未公开的隐藏推理过程。

| **ID**     | **需求**                                                                                                           | **验收**                                           |
|------------|--------------------------------------------------------------------------------------------------------------------|----------------------------------------------------|
| **TH-001** | IR 支持 `summary/text/signature/encryptedContent/reasoningId/providerMetadata`，其中 opaque 字段不得解析或改写。 | round-trip 后 opaque 值字节级一致。                |
| **TH-002** | Anthropic thinking/redacted thinking 可解析为 reasoning block；stream 支持 thinking_delta 与 signature_delta。     | 官方 Anthropic SDK 可累计最终消息。                |
| **TH-003** | OpenAI Chat 无统一 reasoning 标准，映射必须由 ProviderProfile 指定字段名与格式。                                   | 未声明能力时不猜测字段。                           |
| **TH-004** | 目标不支持 reasoning 时支持三种策略：`reject`、`drop_with_warning`、`provider_metadata`；默认不得静默丢弃。  | TranslationReport 明确列出降级。                   |
| **TH-005** | 后续 Responses adapter 支持 reasoning item、summary、encrypted content 与 streaming reasoning events。             | P1 官方 SDK 测试。                                 |
| **TH-006** | Thinking 与 Tool 的交错顺序必须在 IR 中保留；不能把 reasoning 全部移动到文本之后。                                 | thinking→tool→thinking/text 场景通过事件顺序断言。 |

# 9. Core API 设计要求

## 9.1 主 API：完整 Request 透明转换工厂

第一阶段公开 API 必须直接接受 Node.js 18+ 内置 WHATWG `Request`，返回标准 `Response`：

```ts
export type ApiFormat =
  | "openai-chat"
  | "anthropic-messages"
  | "openai-responses";

export interface TranslateOptions<
  From extends ApiFormat,
  To extends ApiFormat,
> {
  from: From;
  to: To;

  /**
   * 默认使用 globalThis.fetch。
   * 仅用于测试、录制、故障注入或自定义连接池。
   */
  fetch?: typeof globalThis.fetch;
}

export type ForwardTranslator = (
  request: Request,
) => Promise<Response>;

export function translate<
  From extends ApiFormat,
  To extends ApiFormat,
>(options: TranslateOptions<From, To>): ForwardTranslator;
```

调用形式：

```ts
const forwardToAnthropic = translate({
  from: "openai-chat",
  to: "anthropic-messages",
});

const response = await forwardToAnthropic(openAIRequest);
```

核心语义：

```text
输入 Request：from 协议
  ├─ URL pathname/query：from 协议
  ├─ headers：from 协议
  └─ body：from 协议

内部：
  from Request
    → target URL
    → target headers
    → target body
    → fetch target Provider
    → target Response/SSE
    → from Response/SSE

输出 Response：from 协议
```

`to` 协议及目标 Provider 的协议细节不得泄漏给 Gateway 的转发调用代码。

## 9.2 Request 的目标定位语义

为了在不增加 `upstreamUrl`、`upstreamHeaders` 或额外 context 的情况下确定上游，输入 URL 使用以下约定：

- **URL origin**：由 Gateway 选择，表示目标 Provider 的 scheme、host 和 port。
- **URL pathname/query**：仍采用 `from` 协议端点形式，由转换器改写为 `to` 协议端点。
- **headers**：全部采用 `from` 协议格式，包括鉴权头。
- **body**：全部采用 `from` 协议格式。

因此，一个 OpenAI Chat → Anthropic Messages 的输入 Request 可以是：

```ts
const openAIRequest = new Request(
  "https://api.anthropic.com/v1/chat/completions",
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${anthropicProviderKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      stream: true,
      messages: [
        {
          role: "user",
          content: "Hello",
        },
      ],
    }),
    signal: clientRequest.signal,
  },
);

const response = await forwardToAnthropic(openAIRequest);
return response;
```

虽然 URL origin 指向 Anthropic，但传入转换器时：

- pathname 是 OpenAI 的 `/v1/chat/completions`；
- 鉴权是 OpenAI 形式的 `Authorization: Bearer ...`；
- body 是 OpenAI Chat Completions 格式。

Gateway 只负责：

1. 选择目标 Provider origin；
2. 选择目标 Provider 的凭据值；
3. 将凭据值放入 `from` 协议规定的鉴权位置；
4. 按 `from` 协议构造完整 Request。

转换核心负责把该 Request 完整重写为目标协议。

> 凭据的**值**属于目标 Provider，但凭据的**HTTP 表达形式**属于 `from` 协议。转换核心只搬运不透明凭据值，不把凭据写入 Canonical IR。

## 9.3 OpenAI Chat → Anthropic Messages 转换示例

输入：

```http
POST https://api.anthropic.com/v1/chat/completions
Authorization: Bearer sk-ant-...
Content-Type: application/json

{
  "model": "claude-sonnet-4-5",
  "stream": true,
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

转换器内部生成：

```http
POST https://api.anthropic.com/v1/messages
x-api-key: sk-ant-...
anthropic-version: 2023-06-01
Content-Type: application/json

{
  "model": "claude-sonnet-4-5",
  "stream": true,
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Hello" }
      ]
    }
  ]
}
```

转换器必须完成：

- `/v1/chat/completions` → `/v1/messages`；
- `Authorization: Bearer <value>` → `x-api-key: <value>`；
- 删除源协议专用 headers；
- 添加目标协议必需 headers，例如 `anthropic-version`；
- OpenAI request body → Canonical Request IR → Anthropic request body；
- Anthropic JSON/SSE response → Canonical Response/Event IR → OpenAI JSON/SSE response。

返回给调用方的 `Response` 仍必须是 OpenAI Chat Completions 语义。

## 9.4 URL 转换要求

URL 转换由协议 adapter 完成，禁止 Gateway 预先传入目标协议 pathname。

```ts
interface EndpointCodec {
  matches(url: URL): boolean;
  toCanonical(url: URL): CanonicalEndpoint;
  fromCanonical(
    endpoint: CanonicalEndpoint,
    targetOrigin: URL,
  ): URL;
}
```

P0 映射：

| from | to | 输入 pathname | 目标 pathname |
| --- | --- | --- | --- |
| openai-chat | anthropic-messages | `/v1/chat/completions` | `/v1/messages` |
| anthropic-messages | openai-chat | `/v1/messages` | `/v1/chat/completions` |
| 相同协议 | 相同协议 | 原 pathname | 原 pathname |

规则：

- 保留输入 URL 的 origin。
- 只重写协议端点 pathname 和协议相关 query 参数。
- 非协议 query 参数按 allowlist 保留。
- 输入 pathname 与 `from` 不匹配时返回 typed validation error，不得猜测。
- 不得接受 body 或 header 覆盖任意目标 origin，避免形成 SSRF 通道。

## 9.5 Header 转换要求

Headers 必须像 body 一样经过协议转换，不能简单透传。

建议内部模型：

```ts
interface CanonicalCredential {
  kind: "api-key" | "bearer";
  value: string;
}

interface HeaderCodec {
  parseCredential(headers: Headers): CanonicalCredential | undefined;
  renderCredential(
    credential: CanonicalCredential | undefined,
    headers: Headers,
  ): Headers;
  sanitizeSourceHeaders(headers: Headers): Headers;
  applyTargetDefaults(headers: Headers): Headers;
}
```

P0 鉴权转换：

| from | to | 输入 | 输出 |
| --- | --- | --- | --- |
| openai-chat | anthropic-messages | `Authorization: Bearer <key>` | `x-api-key: <key>` |
| anthropic-messages | openai-chat | `x-api-key: <key>` | `Authorization: Bearer <key>` |

强制规则：

- 凭据只能作为不透明字符串在 header codec 内短暂存在，不得进入 IR、日志、hooks 或 TranslationReport。
- 目标请求不得同时包含源、目标两套鉴权头。
- 必须删除并重新计算 `content-length`。
- 必须删除 hop-by-hop headers，例如 `connection`、`transfer-encoding`。
- 可保留经过 allowlist 的 tracing headers，例如 `traceparent`。
- 必须过滤 `cookie`、`set-cookie` 和 Gateway 用户鉴权头。
- Anthropic 目标协议默认添加 `anthropic-version: 2023-06-01`；后续可通过 adapter registry 配置兼容 Provider 的默认值，但不作为每请求 context 传递。

## 9.6 Body 与 Stream 模式转换

转换器读取 `from` 请求体并自行判断流式模式：

```ts
const sourcePayload = await request.json();
const stream = sourceCodec.detectStreaming(sourcePayload);
```

不再要求工厂调用方重复传入 `stream: true/false`，避免双重事实来源。

转换过程：

```ts
const canonicalRequest = sourceCodec.parseRequest(sourcePayload);
const targetPayload = targetCodec.renderRequest(canonicalRequest);
```

P0 请求体必须是 JSON。请求体被读取后必须创建新的目标 `Request`：

```ts
const targetRequest = new Request(targetUrl, {
  method: request.method,
  headers: targetHeaders,
  body: JSON.stringify(targetPayload),
  signal: request.signal,
});
```

## 9.7 标准 Response 输出语义

无论是否流式，handler 都返回标准 `Response`：

```ts
const response: Response = await forwardToAnthropic(openAIRequest);
return response;
```

返回值必须完整采用 `from` 协议：

- status：经过错误映射后的源协议可接受状态；
- headers：源协议响应 headers；
- 非流式 body：源协议 JSON；
- 流式 body：源协议 SSE；
- `Response.body`：保持 `ReadableStream<Uint8Array>`，禁止完整缓冲。

### 非流式路径

```ts
const targetResponse = await execute(targetRequest);
const targetPayload = await targetResponse.json();
const canonicalResponse = targetCodec.parseResponse(targetPayload);
const sourcePayload = sourceCodec.renderResponse(canonicalResponse);

return Response.json(sourcePayload, {
  status: mapStatus(targetResponse.status),
  headers: buildSourceHeaders(targetResponse.headers),
});
```

### 流式路径

```ts
const targetResponse = await execute(targetRequest);

const sourceStream = targetResponse.body!
  .pipeThrough(targetStreamCodec.parse())
  .pipeThrough(canonicalEventPipeline())
  .pipeThrough(sourceStreamCodec.encode());

return new Response(sourceStream, {
  status: mapStatus(targetResponse.status),
  headers: buildSourceSSEHeaders(targetResponse.headers),
});
```

`await execute(targetRequest)` 只等待上游响应头，不等待模型生成完成。

流式路径禁止：

```ts
await targetResponse.text();
await targetResponse.json();
await streamToBuffer(targetResponse.body);
```

## 9.8 参考实现伪代码

```ts
export function translate({
  from,
  to,
  fetch: execute = globalThis.fetch,
}: TranslateOptions): ForwardTranslator {
  const source = getProtocolAdapter(from);
  const target = getProtocolAdapter(to);

  return async function forward(request: Request): Promise<Response> {
    if (request.bodyUsed) {
      throw new RequestBodyConsumedError();
    }

    const sourceUrl = new URL(request.url);
    source.endpoint.assertMatches(sourceUrl);

    const sourcePayload = await request.json();
    const canonicalRequest = source.request.parse(sourcePayload);
    const streaming = source.request.detectStreaming(sourcePayload);

    const targetUrl = target.endpoint.render(
      canonicalRequest.endpoint,
      sourceUrl,
    );

    const credential = source.headers.parseCredential(request.headers);
    const targetHeaders = target.headers.render({
      credential,
      sourceHeaders: request.headers,
    });

    const targetPayload = target.request.render(canonicalRequest);

    const targetRequest = new Request(targetUrl, {
      method: request.method,
      headers: targetHeaders,
      body: JSON.stringify(targetPayload),
      signal: request.signal,
    });

    const targetResponse = await execute(targetRequest);

    if (!streaming) {
      return translateBufferedResponse({
        response: targetResponse,
        source,
        target,
      });
    }

    return translateStreamingResponse({
      response: targetResponse,
      source,
      target,
      signal: request.signal,
    });
  };
}
```

## 9.9 背压、取消和生命周期

SSE 转换必须基于 Web Streams `TransformStream` 或等价 pull-based pipeline：

```text
Provider Response.body
  → target SSE parser
  → Canonical StreamEvent
  → source SSE encoder
  → returned Response.body
```

强制要求：

- 下游消费变慢时，不得无限缓存上游事件。
- `request.signal` 中止后必须取消上游 fetch 和转换 pipeline。
- 下游取消返回的 `response.body` 时，必须向上游传播 cancel。
- parser 必须支持 SSE frame 跨任意字节边界切分。
- 首个可输出事件到达后立即 enqueue，不得等待后续事件。
- 流结束、错误和取消只能执行一次 terminal transition。

首字节实时性验收：上游发出 event 1 后暂停至少 2 秒，再发 event 2；下游必须在暂停期间已经收到转换后的 event 1。

## 9.10 错误与 Response Headers 转换

目标协议 headers 不得原样全部返回。

流式至少设置：

```http
content-type: text/event-stream; charset=utf-8
cache-control: no-cache
```

非流式至少设置：

```http
content-type: application/json; charset=utf-8
```

必须删除或重新计算：

- `content-length`
- `content-encoding`
- `transfer-encoding`
- Provider 鉴权 headers
- `set-cookie`
- 会误导源客户端的目标协议 request-id 或 Provider headers

错误处理：

1. **响应头返回前错误**：构造 `from` 协议格式的 JSON error `Response`。
2. **SSE 已开始后的错误**：按 `from` 协议输出 stream error event；无法表达时安全终止并通过内部 hook 报告。

## 9.11 同协议直通

当 `from === to` 时默认进入直通模式：

```ts
translate({
  from: "openai-chat",
  to: "openai-chat",
})(request);
```

直通要求：

- 不解析和重编码 body；
- 不修改 endpoint、鉴权头或协议 headers；
- 保持原始 SSE chunk 和背压；
- 仍允许注入测试用 `fetch`；
- 不得因为 observability hook 而读取完整 body。

## 9.12 测试与诊断接口

公开转发 API保持最小化；测试包可以使用内部详细接口：

```ts
interface TranslationTrace {
  sourceFormat: ApiFormat;
  targetFormat: ApiFormat;
  sourceEndpoint: string;
  targetEndpoint: string;
  streaming: boolean;
  warnings: TranslationWarning[];
}
```

Trace 中禁止包含：

- API Key；
- Authorization、Cookie；
- 完整 prompt、tool arguments 或 thinking 内容；
- 未脱敏的 Provider 响应。

## 9.13 API 验收测试

必须覆盖：

1. 输入 URL path、headers、body 均为 OpenAI Chat，目标 Request 均为 Anthropic Messages。
2. 输入 URL path、headers、body 均为 Anthropic Messages，目标 Request 均为 OpenAI Chat。
3. OpenAI `Authorization: Bearer` 的凭据值正确转换到 Anthropic `x-api-key`。
4. Anthropic `x-api-key` 的凭据值正确转换到 OpenAI `Authorization: Bearer`。
5. 目标请求中不存在源协议鉴权头泄漏。
6. URL origin 保持不变，pathname 按协议转换。
7. body 的 Tool、Thinking、stream 字段按目标协议转换。
8. 返回 Response 的 headers、JSON/SSE 均恢复为 `from` 协议。
9. 流式首事件实时到达，不发生完整缓冲。
10. 客户端取消会中止上游请求和转换 pipeline。

# 10. 多 Provider 测试框架
## 10.1 目标

测试框架不是简单单元测试集合，而是一个可配置的兼容性实验室：使用源协议构造标准 Node `Request`，通过透明 `translate(...)` handler 完成请求转换、上游调用和响应反向转换，得到标准 `Response`，再由相应官方 SDK 或协议解析器消费。测试框架不得绕过主 API 只测试底层 codec。

```text
Node Request（Anthropic 或 OpenAI body）
                    │
                    ▼
translate({ from, to })
       Request → Promise<Response>
                    │
                    ├─ source request → target request
                    ├─ execute target upstream
                    └─ target response/SSE → source response/SSE
                    │
                    ▼
Protocol Validator + Official SDK Parser
                    │
                    ▼
Semantic Assertions
                    │
                    ▼
JSON / JUnit / Markdown Compatibility Report
```

## 10.2 Provider 配置

```yaml
providers:
  - id: openai-native
    protocol: openai_responses
    baseUrl: ${OPENAI_BASE_URL}
    apiKeyEnv: OPENAI_API_KEY
    model: ${OPENAI_TEST_MODEL}
    capabilities: [stream, tools, reasoning]

  - id: anthropic-native
    protocol: anthropic_messages
    baseUrl: ${ANTHROPIC_BASE_URL}
    apiKeyEnv: ANTHROPIC_API_KEY
    model: ${ANTHROPIC_TEST_MODEL}
    capabilities: [stream, tools, thinking]

  - id: compatible-a
    protocol: openai_chat
    baseUrl: ${COMPAT_A_BASE_URL}
    apiKeyEnv: COMPAT_A_API_KEY
    model: ${COMPAT_A_MODEL}
    capabilities: [stream, tools, chat_reasoning_extension]
```

## 10.3 最低 Provider 覆盖

| **类别**                 | **最低数量** | **目的**                                                          |
|--------------------------|--------------|-------------------------------------------------------------------|
| Anthropic 原生或严格兼容 | 1            | 验证 Messages、SSE event ordering、tool_use、thinking/signature。 |
| OpenAI 原生              | 1            | 验证 Chat/Responses、tool_calls、usage、reasoning items。         |
| 第三方 OpenAI-compatible | 1            | 验证非标准 SSE、reasoning_content、字段缺失和兼容差异。           |

## 10.4 测试模式

| **模式**         | **说明**                                                       | **执行时机**    |
|------------------|----------------------------------------------------------------|-----------------|
| Fixture Contract | 使用固定 JSON/SSE fixtures 构造标准 Request，并验证标准 Response、parse/render、状态机和透明 handler。 | 每次 PR，必跑。 |
| Round-trip       | A→IR→A 与 A→IR→B，验证语义和不变量。                           | 每次 PR，必跑。 |
| Live Smoke       | 通过 `translate(...)` 对每个 Provider 执行文本、stream、tool、thinking smoke。 | 每日或手动。    |
| Full Matrix      | 协议×Provider×stream×tool×thinking 全矩阵。                    | 每周与发布前。  |
| Differential     | 可选：与参考开源项目或 native direct call 比较归一化结果。     | 兼容性修复时。  |

## 10.5 断言策略

- 协议断言：JSON Schema、必填字段、event name/type、事件顺序和 block 配对。
- 语义断言：聚合文本非空、tool 名称与参数满足预期、tool result 关联正确、finish reason 合理。
- Thinking 断言：仅断言可见 summary/opaque metadata 的结构、顺序和连续性，不比较私有推理正文。
- 流式断言：首事件、增量数量、结束事件、取消传播、UTF-8/JSON fragmentation。
- 报告断言：任何 lossy 转换都产生 warning；敏感 header/body 字段不进入报告。

## 10.6 成本、稳定性和密钥保护

| **要求**       | **说明**                                                             |
|----------------|----------------------------------------------------------------------|
| **Token 上限** | 每个 scenario 设置 max output token；thinking 场景设置独立预算上限。 |
| **并发限制**   | Provider 级并发与全局并发可配置；默认低并发。                        |
| **预算熔断**   | 支持每次运行最大请求数、最大 token/费用估算，达到阈值立即停止。      |
| **重试策略**   | 仅对明确可重试的网络/429/5xx 场景有限重试；功能断言失败不重试掩盖。  |
| **密钥**       | 只从环境变量/secret store 读取；日志、fixtures、报告必须脱敏。       |
| **可重复性**   | 固定 temperature 或采用结构性断言，不依赖模型输出逐字一致。          |
| **可跳过**     | 无密钥时 live tests 标记 skipped，离线测试仍完整运行。               |

# 11. 测试用例与验收矩阵

| **用例** | **主题**         | **模式**     | **Provider**      | **核心断言**                                    |
|----------|------------------|--------------|-------------------|-------------------------------------------------|
| TC-001   | 基础文本         | 非流式       | 所有              | 返回可解析文本、role/model/ID 正常。            |
| TC-002   | 基础文本         | 流式         | 所有              | 首包及时；文本聚合等于最终消息。                |
| TC-003   | System + 多轮    | 非流式       | 所有              | system/developer 语义保持，多轮顺序正确。       |
| TC-004   | 单 Tool Call     | 非流式       | Tool Provider     | tool name、ID、arguments JSON 正确。            |
| TC-005   | 单 Tool Call     | 流式         | Tool Provider     | start/delta/end 正确；arguments 最终合法。      |
| TC-006   | Tool Result 回注 | 两轮         | Tool Provider     | tool_result/role=tool 能关联并继续生成。        |
| TC-007   | 文本 + Tool 混合 | 流式         | 支持者            | 内容块顺序和 stop reason 正确。                 |
| TC-008   | 并行 Tool        | 流式         | 支持者（P1）      | 两个调用 ID、index 和参数互不串线。             |
| TC-009   | Thinking         | 非流式       | Thinking Provider | summary/opaque metadata 被保留或产生明确降级。  |
| TC-010   | Thinking         | 流式         | Thinking Provider | reasoning start/delta/end 与文本顺序正确。      |
| TC-011   | Thinking + Tool  | 流式         | 支持者            | 交错事件顺序与多轮连续性正确。                  |
| TC-012   | Usage            | 两种         | 所有              | token 字段映射，无重复累计。                    |
| TC-013   | Stop reason      | 两种         | 所有              | end/tool/max/error 映射正确。                   |
| TC-014   | 流内错误         | 流式         | 模拟/真实         | 输出目标协议错误或安全终止，报告含 request id。 |
| TC-015   | 客户端取消       | 流式         | 所有              | Abort 传播，上游连接关闭，无后续 delta。        |
| TC-016   | 分片压力         | 流式 fixture | 离线              | 每字节切分、UTF-8 切分、JSON 切分均正确。       |
| TC-017   | 未知字段/事件    | 两种         | 离线              | 不崩溃；按策略保留/忽略并 warning。             |
| TC-018   | 无损回环         | 非流式/流式  | 离线              | A→IR→A 归一化后等价。                           |
| TC-019   | 透明非流式转发   | 非流式       | 所有              | handler 输入为标准 Request、输出为标准 Response；body 均为 from 协议，to payload 不泄漏。 |
| TC-020   | 透明 SSE 转发    | 流式         | 所有              | execute 接收目标协议，客户端收到源协议 SSE。       |
| TC-021   | 动态凭据隔离     | 两种         | 模拟              | 工厂复用时不同调用的 URL/header/key 不串用。        |
| TC-022   | Stream 配置一致性| 流式/非流式  | 离线              | 工厂 stream 与请求字段冲突时明确拒绝。              |
| TC-023   | 上游错误反向转换 | 两种         | 模拟/真实         | 目标协议错误被转换为源协议错误结构。                |
| TC-024   | 同协议直通       | 两种         | 所有              | from=to 时正确 passthrough，仍应用安全和取消策略。   |

## 11.1 组合矩阵规则

```text
sourceProtocol × provider.nativeProtocol × stream × tools × thinking

P0 最小组合：
- anthropic_messages → openai_chat：non-stream / stream / tool / thinking-policy
- openai_chat → anthropic_messages：non-stream / stream / tool / thinking-extension
- 同协议 passthrough：两种协议各一组
- 每个 Provider 至少执行 text + stream + tool；声明 thinking 的 Provider 追加 thinking 场景
```

# 12. 非功能与安全要求

| **ID**      | **类别** | **要求**                                                                                                 |
|-------------|----------|----------------------------------------------------------------------------------------------------------|
| **NFR-001** | 运行环境 | Node.js >=20；TypeScript strict；优先 ESM；使用标准 Fetch、Web Streams、AbortSignal。                   |
| **NFR-002** | 性能     | 本地基准：<1 MB 非流式 payload 转换 p95 ≤ 5 ms；流式首事件额外转换延迟 p95 ≤ 10 ms。                    |
| **NFR-003** | 内存     | 流转换不得缓存完整响应；内存与活跃 content/tool block 数量相关。                                         |
| **NFR-004** | 可靠性   | Malformed input、未知事件、上游半关闭不得导致进程未捕获异常。                                            |
| **NFR-005** | 可观测性 | 产生 request-scoped trace id、转换耗时、fidelity、warning 数；默认不记录完整 prompt。                    |
| **NFR-006** | 安全     | header allowlist；API key 脱敏；body size limit；timeout；Abort；禁止任意用户输入直接成为 upstream URL。 |
| **NFR-007** | 兼容性   | 输出必须可被对应官方 JS SDK 解析；未知未来事件需优雅处理。                                               |
| **NFR-008** | 可维护性 | 每个协议 codec 独立；核心 API 有稳定版本；IR 变更需 migration note。                                     |
| **NFR-009** | 测试     | P0 分支覆盖率目标 ≥85%；stream 状态机关键分支 ≥95%。                                                     |
| **NFR-010** | 许可证   | 以官方规范 clean-room 实现；第三方代码引入必须记录来源和许可证审查。                                     |
| **NFR-011** | API 组合性 | 主 API 可在 Fastify、Hono、Express、原生 Fetch/Web Streams 环境中使用，不依赖具体 HTTP Server 框架。        |

# 13. 交付物与里程碑
## 13.1 交付物

- `llm-protocol`（单仓单包）：透明 `translate(...)` 工厂、IR、codec、stream codec、pipeline、capabilities、errors。
- `llm-protocol` 内置 `testkit/`：ProviderAdapter、scenario、assertion、reporter（同仓维护，不单独发布）。
- `compat-runner`：CLI，可按 Provider/能力/标签运行测试。
- fixtures：请求、响应、SSE、回归案例，包含来源和预期语义。
- 兼容性报告：JSON + JUnit + Markdown/HTML 摘要。
- 开发文档：新增协议、ProviderProfile、thinking 策略和测试用例指南。

## 13.2 建议里程碑

| **里程碑**           | **内容**                                       | **完成条件**                                        |
|----------------------|------------------------------------------------|-----------------------------------------------------|
| M0：规格与 IR        | 冻结 P0 IR、fidelity、error、capability 模型。 | 评审通过；20+ 核心 fixtures。                       |
| M1：非流式           | Messages ↔ Chat codec 与标准 Request/Response 透明非流式 handler。   | 文本、system、tool、usage、stop 及端到端转发测试通过。 |
| M2：SSE 文本         | SSE parser、event IR、emitter 与标准 Response.body 透明 stream handler。 | 字节分片、背压和官方 SDK stream smoke 通过。         |
| M3：Tool             | tool definition/call/result，流式参数状态机。  | 单 tool 和 tool result 多轮通过。                   |
| M4：Thinking         | reasoning IR、策略、opaque metadata、stream。  | 无静默丢失；支持者 live test 通过。                 |
| M5：Provider Testkit | 三类 Provider、报告、成本/密钥控制。           | 完整 P0 matrix 可一键运行。                         |
| M6：加固发布         | 错误、取消、性能、安全和文档。                 | 满足第 14 节验收标准。                              |

# 14. 第一阶段验收标准

1.  P0 离线 fixtures、round-trip、标准 Request/Response 透明 handler 和 stream state-machine 测试 100% 通过。
2.  至少接入 1 个 Anthropic 协议 Provider、1 个 OpenAI 原生 Provider、1 个第三方 OpenAI-compatible Provider。
3.  每个 Provider 至少通过基础文本、SSE 文本和 Tool 场景；声明 Thinking 的 Provider 必须通过 Thinking 场景。
4.  Anthropic 与 OpenAI 官方 JavaScript SDK 能解析 `translate(...)` 返回的非流式与流式输出。
5.  Tool arguments 在所有成功用例中可组成合法 JSON，Tool ID 在多轮中保持可关联。
6.  SSE 不出现 delta-before-start、重复 end、index 串线、`[DONE]` 处理错误等协议缺陷。
7.  Thinking/Reasoning 不静默丢失；任何降级均体现在 TranslationReport 和测试报告。
8.  客户端取消能中止上游；测试报告中无 API key、Authorization、完整敏感 prompt 泄漏。
9.  性能与覆盖率满足 NFR-002、NFR-003、NFR-009。
10. 新增兼容性问题均有最小 fixture 与回归测试。
11. Gateway 路由处理代码只需把标准 `Request` 交给透明 handler 并返回其标准 `Response`；无需手工拆分 request/execute/response/stream 四段逻辑。
12. 工厂实例可安全复用，不缓存每请求 URL、API Key、headers 或 AbortSignal。
13. 主 API 不暴露自定义 HTTP response envelope，不要求调用方对非流式 body 手工 `JSON.stringify`。
14. 流式 handler 在上游首个 SSE 事件到达后立即通过 `Response.body` 输出；测试证明不存在整流缓冲。
15. 输入 `Request.signal` 中止能够取消上游请求和 SSE pipeline。
16. Fastify/Hono/Node HTTP 适配代码位于协议核心之外。

# 15. 风险与缓解措施

| **风险**             | **影响**                                   | **缓解**                                                                             |
|----------------------|--------------------------------------------|--------------------------------------------------------------------------------------|
| 协议快速变化         | 字段和事件新增导致兼容回归。               | 官方文档/SDK优先；unknown event 容忍；每周上游变更汇总转为 fixture。                 |
| Chat Thinking 非标准 | 不同 Provider 字段和语义不一致。           | ProviderProfile 明确能力；无声明不猜测；支持 reject/drop_with_warning/metadata。     |
| 真实模型不确定性     | Live test 偶发失败。                       | 结构断言、低 temperature、确定性 tool prompt、有限重试、区分协议失败与模型行为失败。 |
| 测试成本             | 全矩阵消耗费用和额度。                     | token 上限、预算熔断、分层执行：PR 离线、每日 smoke、每周 full。                     |
| 上游项目许可证       | 直接移植可能产生版权/开源义务。            | clean-room；只吸收规范、issue、fixture；代码引入做许可证审查。                       |
| SSE 边界复杂         | 分片、取消、错误容易产生隐蔽缺陷。         | 事件 IR、状态机不变量、每字节 fragmentation fuzz、SDK 黑盒解析。                     |
| Provider 假兼容      | 号称 OpenAI-compatible 但字段/事件不标准。 | 能力矩阵和 provider-specific extension；不污染通用 codec。                           |

# 附录 A：数据模型草案
## A.1 Canonical Content Part

```ts
type ContentPart =
  | { type: "text"; text: string; annotations?: unknown[] }
  | { type: "image"; source: ImageSource }
  | {
      type: "tool_call";
      id: string;
      name: string;
      argumentsText: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      content: ContentPart[];
      isError?: boolean;
    }
  | {
      type: "reasoning";
      summary?: string;
      text?: string;
      signature?: string;
      encryptedContent?: string;
      reasoningId?: string;
      providerMetadata?: unknown;
    };
```

## A.2 Canonical Request / Response

```ts
interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  system?: ContentPart[];
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  generation?: CanonicalGenerationOptions;
  thinking?: CanonicalThinkingConfig;
  extensions?: Record<string, unknown>;
}

interface CanonicalResponse {
  id?: string;
  model?: string;
  content: ContentPart[];
  finishReason?: CanonicalFinishReason;
  usage?: CanonicalUsage;
  extensions?: Record<string, unknown>;
}
```

## A.3 Translation Policy

```ts
interface TranslationPolicies {
  unsupportedField:
    | "reject"
    | "drop_with_warning"
    | "preserve_extension";
  reasoning:
    | "reject"
    | "drop_with_warning"
    | "provider_metadata";
  unknownStreamEvent:
    | "ignore_with_warning"
    | "preserve_extension"
    | "reject";
  invalidToolArguments:
    | "reject"
    | "buffer_until_valid";
  generateMissingIds: boolean;
}
```

# 附录 B：参考资料

| **编号** | **资料**                       | **地址**                                                                     | **用途**                                                                       |
|----------|--------------------------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------------|
| R1       | rosetta-llm Repository         | https://github.com/Lokesh-Chimakurthi/rosetta-llm                            | 多格式双向代理、端点和特性说明。                                               |
| R2       | rosetta-llm Source Structure   | https://github.com/Lokesh-Chimakurthi/rosetta-llm/tree/main/src/rosetta      | codecs、ir、stream_codecs、pipeline、upstream 等目录。                         |
| R3       | CLIProxyAPI README / SDK       | https://github.com/router-for-me/CLIProxyAPI                                 | OpenAI/Gemini/Claude/Codex 兼容端点、stream、tool 与 translator/executor SDK。 |
| R4       | Sub2API / New API              | https://github.com/Wei-Shaw/sub2api ; https://github.com/QuantumNous/new-api | 生产兼容问题和多 Provider 能力参考。                                           |
| R5       | OpenAI Responses Streaming API | https://platform.openai.com/docs/api-reference/responses-streaming           | Responses SSE、function call、reasoning item 和 usage。                        |
| R6       | Anthropic Streaming Messages   | https://platform.claude.com/docs/en/build-with-claude/streaming              | Messages SSE 事件顺序、tool input JSON delta、thinking/signature delta。       |
| R7       | Anthropic Thinking             | https://platform.claude.com/docs/en/build-with-claude/extended-thinking      | thinking 配置、流式、工具工作流与 opaque metadata 处理。                       |

> **需求基线说明：** 本文件用于第一阶段架构评审和研发拆分。OpenAI Responses 的完整 adapter 为 P1，但 IR、stream event 和 ProviderProfile 必须从第一阶段开始预留，避免后续重构。
