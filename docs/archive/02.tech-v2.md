# llm-protocol：Messages ↔ Chat 兼容性加固技术设计

**文档版本：** v0.1  
**日期：** 2026-08-07  
**适用仓库：** `geebos/llm-protocol`  
**范围：** Anthropic Messages ↔ OpenAI Chat Completions  
**重点：** 非流式转换、SSE 流式转换、Tool Calling、Thinking/Reasoning、Usage、终止语义与 OpenAI-compatible 上游兼容性

---

## 1. 背景

`llm-protocol` 当前已经完成 Phase 1 的主体能力：

- `Anthropic Messages ↔ OpenAI Chat` 双向转换
- 标准 `Request -> Promise<Response>` 透明转发接口
- Canonical IR
- 非流式 Request / Response codec
- SSE parser / renderer
- Tool call / tool result
- Thinking / reasoning
- Usage / finish reason
- ProviderProfile
- TranslationReport / fidelity policy
- Web Streams、取消传播、超时、错误反向转换
- fixture / live provider compatibility test framework

当前主要问题已经不再是“协议能不能转换”，而是：

> 如何在真实 OpenAI-compatible Provider、Claude-compatible Provider 以及非标准 SSE 行为下，保持状态机合法、字段不丢失、Tool/Thinking/Usage 不错序，并保证官方 SDK 可以稳定消费。

因此本阶段目标不是重写架构，而是对 `Messages ↔ Chat` 做生产级兼容性加固。

---

## 2. 参考实现

本阶段继续保持 clean-room / spec-driven 原则。

第三方项目主要用于：

- 发现兼容性 case
- 观察成熟项目的状态机处理方式
- 构造 regression fixtures
- 对比行为差异

不将第三方实现作为协议标准，也不自动同步源码。

重点参考项目：

| 项目 | 主要参考价值 |
| --- | --- |
| `Lokesh-Chimakurthi/rosetta-llm` | Canonical IR、简洁的 Messages/Chat streaming state、thinking/tool mapping |
| `router-for-me/CLIProxyAPI` | 非标准 OpenAI-compatible 流、tool call 分片、thinking compatibility、真实 provider 边界 |
| `Wei-Shaw/sub2api` | Messages ↔ Chat direct bridge、usage 语义、复杂 tool/result、终止事件处理 |
| `QuantumNous/new-api` | provider dialect、parallel tools、adaptive thinking、golden/terminal stream tests |

优先级原则：

1. 官方 OpenAI / Anthropic API 规范
2. 官方 SDK 实际解析行为
3. `llm-protocol` compatibility fixtures
4. 主流开源实现的实际兼容 case

---

## 3. 当前架构

当前主链路：

```text
Client Request (from protocol)
        │
        ▼
Request Codec
        │
        ▼
CanonicalRequest
        │
        ▼
Target Request Codec
        │
        ▼
Target Request
        │
        ▼
Provider
        │
        ├──────── Non-stream ────────┐
        │                            │
        ▼                            ▼
Target Response                Target SSE
        │                            │
Response Codec                  SSE Parser
        │                            │
        ▼                            ▼
CanonicalResponse       CanonicalStreamEvent
        │                            │
        ▼                            ▼
Source Response Codec       Source SSE Renderer
        │                            │
        └──────────────┬─────────────┘
                       ▼
                 Client Response
```

公开 API：

```ts
const forward = translate({
  from: "openai-chat",
  to: "anthropic-messages",
});

const response: Response = await forward(request);
```

接口语义：

- 输入 `Request` 完整采用 `from` 协议
- `translate()` 内部完成 endpoint/header/body 转换
- 内部调用目标 Provider
- 输出重新转换回 `from` 协议
- 流式场景返回实时 `Response.body`
- 禁止对 SSE 完整缓冲

该总体设计保持不变。

---

## 4. 当前实现状态

### 4.1 已完成能力

| 能力 | 状态 |
| --- | --- |
| Text 非流式双向转换 | 已完成 |
| Text SSE 双向转换 | 已完成 |
| System / Developer | 已完成基础映射 |
| Image | 已完成基础映射 |
| Tool definition | 已完成 |
| Tool choice | 已完成基础映射 |
| Tool call | 已完成 |
| Tool result | 已完成基础多轮支持 |
| Parallel tool call | 已具备基础流事件模型 |
| Thinking text | 已支持 |
| Anthropic signature/redacted thinking | 已有 IR 表示 |
| Usage | 已有 CanonicalUsage |
| Stop / finish reason | 已有统一表示 |
| SSE framing | 已有独立 byte-level parser |
| SSE event validator | 已完成 |
| Cancellation / Backpressure | 已完成基础能力 |
| ProviderProfile | 已完成基础能力 |
| Fidelity policy | 已完成 |
| Error reverse translation | 已完成 |

### 4.2 当前核心 gap

```text
                 功能覆盖
                    │
                    ▼
            已基本达到完整
                    │
                    ▼
        现在主要缺的是 compatibility
                    │
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
SSE 状态机      Tool 分片      Usage/终止语义
```

---

## 5. Gap 总表

| ID | Gap | 当前状态 | 优先级 |
| --- | --- | --- | --- |
| GAP-001 | Thinking/Text/Tool block 切换 | 不完整 | P0 |
| GAP-002 | Tool call 的 id/name/arguments 任意分片顺序 | 不完整 | P0 |
| GAP-003 | `finish_reason` 与 late usage 分离 | 不完整 | P0 |
| GAP-004 | OpenAI known fields 被识别但没有进入 IR/extensions | 存在风险 | P0 |
| GAP-005 | `parallel_tool_calls` 映射 | 不完整 | P0 |
| GAP-006 | `reasoning_effort` / adaptive thinking | 不完整 | P0 |
| GAP-007 | Anthropic tool_result ordering / adjacent role normalization | 不完整 | P0 |
| GAP-008 | Cache token usage 双向语义 | 不完整 | P1 |
| GAP-009 | Thinking signature 跨 Chat round-trip | 部分支持 | P1 |
| GAP-010 | `[DONE]` / EOF / finish / usage 统一 finalize | 不完整 | P1 |
| GAP-011 | Tool ID / Name provider quirks | 部分支持 | P1 |
| GAP-012 | Empty / malformed provider stream tolerance | 部分支持 | P1 |
| GAP-013 | Anthropic ping / keepalive | 未主动生成 | P2 |
| GAP-014 | Provider-specific Chat dialect | ProviderProfile 基础支持 | P2 |

---

## 6. P0-1：统一 Streaming Content Block 状态机

### 6.1 问题

OpenAI Chat SSE 没有 Anthropic 那么严格的 content block 生命周期。

OpenAI-compatible Provider 可能产生：

```text
reasoning delta
reasoning delta
text delta
text delta
tool call
tool call
```

Anthropic SSE 则要求：

```text
content_block_start
content_block_delta*
content_block_stop
```

并且同一个 block index 的类型不能发生变化。

当前 Chat parser 不能保证在以下转换时关闭前一 block：

```text
thinking → text
thinking → tool
text     → tool
tool     → text
```

可能导致 Canonical Event 为：

```text
reasoning_start(0)
reasoning_delta(0)

text_start(0)
text_delta(0)
```

缺少：

```text
reasoning_end(0)
```

最终可能产生 Anthropic SDK 无法接受的 SSE。

### 6.2 设计目标

Chat stream parser 必须维护显式 active content state：

```ts
interface OpenAIChatStreamState {
  messageStarted: boolean;

  reasoning?: {
    started: boolean;
    ended: boolean;
  };

  text?: {
    started: boolean;
    ended: boolean;
  };

  tools: Map<number, ToolCallStreamState>;

  phase:
    | "initial"
    | "reasoning"
    | "text"
    | "tools"
    | "finished";
}
```

### 6.3 Phase 切换规则

**reasoning → text**

```text
reasoning_end
text_start
text_delta
```

**reasoning → tool**

```text
reasoning_end
tool_start
tool_arguments_delta
```

**text → tool**

```text
text_end
tool_start
tool_arguments_delta
```

**tool → text**

如果 Provider 出现这种非标准序列：

```text
tool delta
text delta
```

需要：

1. close 已打开的 tool blocks
2. 记录 `provider_nonstandard_interleaving` warning
3. 开始 text block

---

## 7. P0-2：ToolCallAccumulator

### 7.1 问题

真实 OpenAI-compatible Provider 可能将 tool call 拆成：

```text
chunk 1:
index=0
id=call_123

chunk 2:
index=0
function.name=search

chunk 3:
index=0
function.arguments="{"

chunk 4:
index=0
function.arguments="\"query\":\"..."
```

也可能：

```text
arguments 先到
id 后到
name 最后到
```

不能假定第一块同时具有 `id + name`。

### 7.2 新状态结构

```ts
interface ToolCallStreamState {
  sourceIndex: number;

  id?: string;
  name?: string;

  pendingArguments: string;

  started: boolean;
  ended: boolean;

  outputIndex?: number;
}
```

状态存储：

```ts
tools: Map<number, ToolCallStreamState>;
```

### 7.3 tool_start 发射规则

推荐策略：只有 `name` 已知时才发射 `tool_start`。

ID：

- 如果 id 已知：使用上游 ID
- 如果 name 已知但 id 暂未出现，可以继续短暂 defer
- 到达 arguments 前仍无 id 时，生成 synthetic id
- finalize 时仍没有 id，必须生成 synthetic id

生成 ID 必须：

- request 内稳定
- 不与其他 call 冲突
- 进入 TranslationReport

### 7.4 arguments buffering

如果 arguments 在 tool_start 前到达：

```text
pendingArguments += fragment
```

tool_start 发出后：

```text
tool_start
tool_arguments_delta(pendingArguments)
```

后续 arguments 继续逐块输出，不得丢失。

### 7.5 Finalize

stream 结束时：

```text
for every unfinished tool:
    if not started:
        synthesize missing fields
        emit tool_start

    flush pending arguments
    emit tool_end
```

并记录：

```text
synthesized_tool_id
missing_tool_name
provider_tool_fragment_reordered
```

---

## 8. P0-3：Finish Reason 与 Transport Terminal 分离

### 8.1 问题

常见 OpenAI-compatible SSE：

```text
chunk N:
choices[0].finish_reason = "stop"

chunk N+1:
choices = []
usage = {...}

chunk N+2:
data: [DONE]
```

当前如果在 `finish_reason` 到达时立即产生：

```text
message_end
```

validator 会进入 terminal，后续 usage 可能被误判为 `event after terminal transition`。

### 8.2 新语义

必须区分“业务结束信号”和“transport 真正结束”。

Canonical 内不一定要暴露新 public event，但 parser 内部必须缓存：

```ts
interface StreamFinalizeState {
  finishReason?: CanonicalFinishReason;
  usage?: CanonicalUsage;

  finishObserved: boolean;
  doneObserved: boolean;
  eofObserved: boolean;

  finalized: boolean;
}
```

### 8.3 finalize 时机

产生真正 `message_end` 的条件：

```text
[DONE]
```

或：

```text
EOF
```

而不是单独依赖 `finish_reason`。

### 8.4 推荐事件顺序

```text
message_start
content events...
usage?
message_end
```

Anthropic renderer 再把 usage + finish 折叠为：

```text
message_delta
message_stop
```

---

## 9. P0-4：OpenAI Known Fields 保留

### 9.1 问题

当前 Request codec 维护 `KNOWN_FIELDS`，但某些字段：

```text
parallel_tool_calls
reasoning_effort
stream_options
store
metadata
user
n
logprobs
top_logprobs
response_format
service_tier
modalities
audio
```

被标记为 known 后，不会进入 unknown extensions，但其中一部分又没有映射进 CanonicalRequest。

这会产生：

```text
输入存在
→ parser 不保存
→ renderer 无法恢复
→ 字段静默消失
```

### 9.2 设计规则

每一个 known field 必须属于以下三类之一：

```text
1. 映射到 Canonical IR
2. 存入 extensions
3. 明确 drop + warning
```

禁止：

```text
known but ignored
```

---

## 10. P0-5：parallel_tool_calls

建议 CanonicalRequest 增加：

```ts
interface CanonicalRequest {
  // ...
  parallelToolCalls?: boolean;
}
```

映射：

```text
OpenAI:
parallel_tool_calls=false

Anthropic:
tool_choice.disable_parallel_tool_use=true
```

反向同理；无法表示时进入 TranslationReport。

---

## 11. P0-6：Reasoning / Thinking Config 升级

### 11.1 当前表示不足

现有：

```ts
{
  enabled: boolean;
  budgetTokens?: number;
}
```

不足以覆盖：

```text
disabled
enabled + budget
adaptive
effort
```

### 11.2 新 CanonicalThinkingConfig

建议：

```ts
interface CanonicalThinkingConfig {
  mode:
    | "disabled"
    | "enabled"
    | "adaptive";

  budgetTokens?: number;

  effort?:
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";

  display?: string;

  providerMetadata?: Record<string, unknown>;
}
```

### 11.3 映射策略

Anthropic：

```text
thinking.type
thinking.budget_tokens
output_config.effort
```

进入 CanonicalThinkingConfig。

OpenAI Chat 可能来自：

```text
reasoning_effort
reasoning
reasoning_content
provider-specific field
```

必须通过 `ProviderProfile` 声明，而不是 core 根据 model 名硬编码。

---

## 12. P0-7：Anthropic Message Normalization

### 12.1 问题

Anthropic Messages 对消息结构比 OpenAI Chat 更严格，尤其 `tool_result` 必须出现在合法 user turn 中，并应优先于普通文本内容。

OpenAI Chat 可能是：

```text
assistant tool_calls
tool result
tool result
user message
```

直接逐条转换容易形成连续 user turns 或 tool_result/text 顺序不符合预期。

### 12.2 引入 normalization pass

建议：

```ts
function normalizeAnthropicTurns(
  request: CanonicalRequest,
  report: TranslationReport,
): CanonicalRequest
```

放在：

```text
CanonicalRequest
    ↓
normalizeAnthropicTurns
    ↓
Anthropic render
```

### 12.3 规则

1. 合并连续 user turns
2. 合并连续 assistant turns
3. 同一 user turn 中 `tool_result` 排在 text/image 之前
4. 孤立 tool result 自动包装为 user turn
5. Assistant 的 thinking/text/tool_use 保持稳定顺序
6. 所有兼容规整进入 TranslationReport

---

## 13. P1-1：Cache Usage 语义

### 13.1 Anthropic

```text
input_tokens
cache_read_input_tokens
cache_creation_input_tokens
output_tokens
```

### 13.2 OpenAI Chat

典型：

```text
prompt_tokens
completion_tokens
prompt_tokens_details.cached_tokens
```

兼容 Provider 还可能有：

```text
cache_write_tokens
cache_creation_tokens
cached_creation_tokens
```

### 13.3 CanonicalUsage

```ts
interface CanonicalUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;

  cacheReadTokens?: number;
  cacheCreationTokens?: number;

  providerDetails?: Record<string, unknown>;
}
```

### 13.4 Anthropic → Chat

若 Anthropic input 不包含 cache：

```text
prompt_tokens =
    input_tokens
  + cache_read_input_tokens
  + cache_creation_input_tokens
```

### 13.5 Chat → Anthropic

若 `prompt_tokens` 包含 cached：

```text
input_tokens =
  prompt_tokens
  - cache_read
  - cache_creation
```

结果必须 clamp 到 `>= 0`。

---

## 14. P1-2：Thinking Signature / Opaque State

Anthropic 的：

```text
thinking.signature
redacted_thinking.data
```

可能是下一轮继续 thinking 的必要 opaque state，而 Chat 标准没有对应字段。

建议升级 ProviderProfile：

```ts
interface ReasoningCapability {
  text: boolean;
  opaqueSignature: boolean;
  resumable: boolean;

  requestField?: string;
  responseField?: string;
  streamField?: string;
}
```

Policy：

- `reject`：无法保持 signature 时拒绝
- `drop_with_warning`：只保留可见 reasoning text
- `provider_metadata`：Provider 明确声明支持时保存 opaque state

禁止 core 猜测非标准字段。

---

## 15. P1-3：统一 Stream Finalizer

推荐所有 stream parser 使用统一 finalizer 思路：

```ts
interface StreamFinalizer {
  onChunk(...): void;
  onFinishReason(...): void;
  onUsage(...): void;
  onDone(...): void;
  onEOF(...): void;

  finalize(): CanonicalStreamEvent[];
}
```

统一处理：

```text
finish_reason
[DONE]
EOF
usage-only chunk
abrupt close
provider error
```

---

## 16. SSE Parser

当前 byte-level SSE parser 保持不变。

继续保证：

- UTF-8 多字节字符跨 chunk
- LF / CRLF
- `\r` 跨 chunk
- multi-line `data:`
- comment line
- blank line frame delimiter
- unknown field ignore
- Web Streams backpressure

本阶段重点：

```text
不要重写 framing
只升级 protocol stream state
```

---

## 17. 测试方案

兼容性加固必须 fixture-first。

### L1：Codec Unit Tests

```text
request parse
request render
response parse
response render
```

### L2：Stream State Unit Tests

```text
SSEFrame[] → CanonicalStreamEvent[]
```

### L3：Stream Render Tests

```text
CanonicalStreamEvent[] → SSE bytes
```

### L4：Full Pipeline Fixture

```text
Request(from)
   ↓
translate()
   ↓
mock provider SSE
   ↓
Response(from)
```

必须通过 public `translate()` API。

### L5：Official SDK Black-box

使用 OpenAI JS SDK / Anthropic JS SDK 实际解析转换后的 Response。

### L6：Live Provider Matrix

```text
OpenAI native
Anthropic native
OpenAI-compatible A
OpenAI-compatible B
Claude-compatible relay
```

---

## 18. 新增核心 Streaming Fixtures

### STREAM-001：reasoning → text

输入：

```text
reasoning_content
reasoning_content
content
content
finish
usage
DONE
```

断言：

```text
thinking start
thinking delta*
thinking stop
text start
text delta*
text stop
message_delta
message_stop
```

### STREAM-002：reasoning → tool

thinking 必须先 stop，然后才能开始 tool block。

### STREAM-003：tool id/name 分片

```text
chunk 1 id
chunk 2 name
chunk 3 arguments
```

不得生成永久 placeholder name。

### STREAM-004：arguments 先于 name

arguments 必须 buffer，不得触发 validator error。

### STREAM-005：finish → usage-only → DONE

确保：

```text
finish reason 不立即 terminal
late usage 被保留
```

### STREAM-006：无 `[DONE]` 的 EOF

必须：

- finalize open blocks
- 生成合理 terminal
- warning 标记 provider abnormal close

### STREAM-007：tool name 永不到达

finalize 必须不丢 arguments，并产生 warning。

### STREAM-008：多个 parallel tool calls

```text
tool index=0
tool index=1
arguments interleaved
```

每个 index 独立 accumulator。

### STREAM-009：usage 先到 finish 后到

也必须合法。

### STREAM-010：error mid-stream

必须：

- 停止继续输出业务事件
- 反向转换成 from-protocol error event
- 不重复 terminal

---

## 19. 非流式新增 Fixtures

### NONSTREAM-001：parallel_tool_calls=false

验证 `Chat → Messages → Chat` 语义保持。

### NONSTREAM-002：reasoning_effort

根据 ProviderProfile 映射到 thinking/adaptive/effort。

### NONSTREAM-003：adaptive thinking

```json
{
  "thinking": {
    "type": "adaptive"
  },
  "output_config": {
    "effort": "high"
  }
}
```

必须可进入 IR。

### NONSTREAM-004：多 tool_result

输入：

```text
tool result A
tool result B
user text
```

输出 Anthropic：

```text
user:
  tool_result A
  tool_result B
  text
```

### NONSTREAM-005：cache usage

验证 prompt token 合成 / 拆分。

---

## 20. Compatibility Test Matrix

| Scenario | Chat→Messages | Messages→Chat | Offline | Live |
| --- | --- | --- | --- | --- |
| Text | Required | Required | Required | Required |
| Stream Text | Required | Required | Required | Required |
| Tool | Required | Required | Required | Required |
| Parallel Tool | Required | Required | Required | Required |
| Tool result round 2 | Required | Required | Required | Required |
| Reasoning | Required | Required | Required | Required |
| Reasoning→Text | Required | Required | Required | Recommended |
| Reasoning→Tool | Required | Required | Required | Recommended |
| Late Usage | Required | N/A | Required | Recommended |
| Cache Usage | Required | Required | Required | Recommended |
| Malformed Tool Fragment | Required | N/A | Required | Optional |
| EOF without DONE | Required | N/A | Required | Optional |

---

## 21. ProviderProfile 扩展

建议：

```ts
interface ProviderProfile {
  protocol: ApiFormat;

  capabilities: {
    streaming: boolean;

    tools: boolean;
    parallelTools: boolean;

    thinking: ReasoningCapability;

    usage: {
      cacheRead?: boolean;
      cacheCreation?: boolean;
      usageAfterFinish?: boolean;
    };

    stream: {
      doneMarker?: boolean;
      mayOmitRoleChunk?: boolean;
      maySplitToolMetadata?: boolean;
    };
  };
}
```

原则：

> Provider quirks 进入 Profile，不进入核心 model-name heuristics。

---

## 22. TranslationReport 新增 Warning Codes

```text
provider_nonstandard_interleaving
tool_metadata_deferred
synthesized_tool_id
missing_tool_name
late_usage
stream_closed_without_done
stream_closed_without_finish
adaptive_thinking_downgraded
parallel_tools_downgraded
cache_usage_approximation
thinking_signature_dropped
```

---

## 23. 实现计划

### M7.1：Streaming State Hardening

实现：

- active block state
- reasoning/text/tool transitions
- ToolCallAccumulator
- deferred tool start
- stream finalizer
- late usage

验收：

```text
STREAM-001 ~ STREAM-010 全部通过
```

### M7.2：Request / Non-stream Semantics

实现：

- known field preservation
- parallel_tool_calls
- adaptive thinking
- reasoning_effort
- message normalization

验收：

```text
NONSTREAM-001 ~ NONSTREAM-005 全部通过
```

### M7.3：Usage Semantics

实现：

- Anthropic cache usage
- Chat cached token detail
- total/input/cache 双向计算

### M7.4：Provider Compatibility

增加多个 native / compatible provider 的 live test。

---

## 24. 验收标准

### 24.1 流式正确性

必须满足：

```text
message_start 最多一次
block start/delta/end 配对
不能向未开始 block 发送 delta
block 类型不能改变
每个 block 最多 stop 一次
terminal 最多一次
terminal 后不能有业务事件
```

late usage 属于 parser finalize 内部状态，不允许被 validator 误判。

### 24.2 Tool

必须覆盖：

```text
ID 先到
Name 先到
Arguments 先到
ID/Name 分开
多个 tool 并行
arguments 任意 fragment 边界
missing ID
missing Name
```

不能静默丢 arguments。

### 24.3 Thinking

必须覆盖：

```text
enabled
disabled
adaptive
budget_tokens
effort
thinking_delta
signature_delta
redacted_thinking
```

无法无损时必须有 report。

### 24.4 SSE 实时性

测试：

```text
upstream event 1
sleep
upstream event 2
```

客户端必须在 sleep 期间已经收到 event 1。

Streaming path 禁止：

```ts
await response.text();
await response.json();
readAll(response.body);
```

### 24.5 SDK Compatibility

转换后的 Response 必须可以被 OpenAI JS SDK / Anthropic JS SDK 正常解析。

---

## 25. 不做事项

当前阶段不处理：

- OpenAI Responses API
- Gemini 协议
- Provider routing
- credential pool
- billing engine
- OAuth
- Gateway auth
- model alias routing
- 自动根据 model name 判断 provider capability
- 全量复制 New API / CLIProxyAPI / Sub2API 行为

---

## 26. 最终目标

完成本阶段后，`llm-protocol` 应从：

```text
Messages ↔ Chat 功能完整
```

提升为：

```text
Messages ↔ Chat 生产级兼容核心
```

核心特征：

```text
标准 Request / Response API
Canonical IR
严格且可恢复的 SSE state machine
Tool fragment accumulator
Thinking / adaptive reasoning
late usage / finalize
Anthropic turn normalization
ProviderProfile 驱动兼容
fixture-first regression
multi-provider live compatibility
```

长期继续保持：

> 吸收其他开源项目踩过的兼容性 case，而不是吸收它们的整体架构或复制实现代码。
