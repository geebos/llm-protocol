# llm-protocol

[English](README.md) | **简体中文**

**最新版本：** [`v1.0.2`](https://github.com/geebos/llm-protocol/commit/6fb613f)

Clean-room 实现的 LLM 协议转换内核（Phase 1）：**Anthropic Messages ↔ OpenAI Chat** 双向请求/响应/流式转换，输入输出均为 Node.js 标准 `Request` / `Response`，可嵌入任何 HTTP 框架（Fastify / Hono / Express / 原生 Fetch）。

- **协议规范**：以 OpenAI / Anthropic 官方 API 与官方 JS SDK 行为为准绳，不依赖任何第三方转换项目。
- **IR 解耦**：所有跨协议转换经 Canonical IR，不写大量 A→B 直接映射。
- **不静默降级**：Thinking、Tool、Usage 等无法无损映射时，一律进入 `TranslationReport`（警告/策略/拒绝）。
- **完整需求规格**：[`docs/tech.md`](docs/tech.md)（v0.5）。

## 特性

| 能力 | 支持 |
| --- | --- |
| 协议 | Anthropic Messages ↔ OpenAI Chat（`openai-responses` 预留为 P1） |
| 模式 | 非流式 JSON、SSE 流式（实时 `Response.body`，不缓冲） |
| 内容 | system / 多轮文本 / 图片 / Tool 定义 / Tool 调用 / Tool 结果（含多轮回注与并行调用） |
| Thinking | thinking / redacted_thinking / signature 双向映射，含三策略（reject / drop_with_warning / provider_metadata） |
| 状态 | usage、finish/stop reason、ID、model、错误反向转换 |
| 安全 | 凭据不透明搬运、header 清洗、body 大小限制、超时、取消传播、trace 脱敏 |

## 安装

```bash
npm install llm-protocol
```

Node.js ≥ 20（使用标准 Fetch、Web Streams、AbortSignal）。

## 快速开始

### 1. 透明转换工厂（主 API）

`translate({ from, to })` 返回一个 `Request → Promise<Response>` handler：

```ts
import { translate } from "llm-protocol";

// 创建「OpenAI Chat 客户端 → Anthropic 上游」的转发器
const forwardToAnthropic = translate({
  from: "openai-chat",
  to: "anthropic-messages",
});

// 输入必须是 OpenAI Chat 协议（path / headers / body 全是 from 协议）
const openAIRequest = new Request(
  "https://api.anthropic.com/v1/chat/completions", // origin 由调用方选择，指向目标 Provider
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

// 返回的 Response 恢复为 OpenAI Chat 协议：
// - 非流式：OpenAI JSON
// - 流式：OpenAI SSE（Response.body 为实时 ReadableStream，可被官方 SDK 解析）
return response;
```

目标协议（URL 改写、鉴权头、`anthropic-version`、body 转换、响应反向转换）全部在工厂内部完成，不泄漏到调用方。

### 2. 在 HTTP 框架中使用

```ts
// Fastify 示例（NFR-011：协议核心与 HTTP Server 解耦）
app.post("/v1/chat/completions", async (request, reply) => {
  const req = new Request(
    `http://upstream-host.example.com${request.url}`,
    { method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: request.raw.signal },
  );
  const response = await forwardToAnthropic(req);
  reply.code(response.status).headers(Object.fromEntries(response.headers)).send(response.body);
});
```

### 3. 选项

```ts
translate({
  from: "openai-chat",
  to: "anthropic-messages",

  // 注入上游执行器（测试 / 录制 / 故障注入）。默认 globalThis.fetch。
  fetch: myFetch,

  // 覆盖某端 ProviderProfile（如声明 Chat reasoningField，TH-003）
  profiles: {
    "openai-chat": {
      protocol: "openai-chat",
      capabilities: { tools: true, parallelTools: true, streaming: true, thinking: true, reasoningField: "reasoning_content" },
      defaultHeaders: {},
    },
  },

  // 转换策略（附录 A.3）。默认：reasoning 降级时 drop_with_warning 并报告
  policies: { reasoning: "provider_metadata" },

  // 安全（NFR-006）
  maxBodyBytes: 10 * 1024 * 1024, // 请求体上限，默认 10 MiB
  timeoutMs: 30_000,              // 上游超时，超时抛 kind="timeout" 的 TranslationError

  // 诊断（NFR-005）：traceId / durationMs / 最差 fidelity / warnings；不含密钥或完整 prompt
  trace: (t) => console.log(t.traceId, t.fidelity, t.warnings),
});
```

### 4. 同协议直通

`from === to` 时走 fast path：不解析、不重写 body，保留原始 chunk 与背压，仅应用取消与 trace（FR-006 / 9.11）。

```ts
translate({ from: "openai-chat", to: "openai-chat" })(request); // passthrough
```

## 兼容性测试（testkit + compat-runner）

内置多 Provider 兼容性实验室：通过公开 `translate()` handler 构造标准 `Request`，调用上游，再交给协议断言 / 官方 SDK 消费（不绕过主 API 只测底层 codec）。

### 运行

```bash
# 离线 fixture 矩阵（不打真实 API，必跑）
npm run compat -- --offline-only

# 全量：离线 + live smoke（需配置 key）
npm run compat

# 指定 provider / 标签 / 预算
npm run compat -- --provider anthropic-native --tag stream
npm run compat -- --budget 20 --reports-dir ./reports
```

### 配置 Provider（`.env`）

```bash
cp .env.example .env
```

| 变量 | 说明 |
| --- | --- |
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_TEST_MODEL` | Anthropic 原生（默认官方 `api.anthropic.com`） |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_TEST_MODEL` | OpenAI 原生（默认官方 `api.openai.com`） |
| `COMPAT_A_BASE_URL` / `COMPAT_A_API_KEY` / `COMPAT_A_MODEL` | 第三方 OpenAI-compatible（baseUrl/model 无默认，必填） |

行为约定：

- key 只从环境变量 / `.env` 读取；`compat-runner` 启动时自动加载 `.env`（shell 已导出的变量优先，**不会**被 `.env` 覆盖）。
- 若 shell 变量与 `.env` 值不一致，启动时打印遮蔽警告。
- 未配置 key 时 live 场景标记 `skipped`，离线矩阵仍完整运行，不会导致整体失败。
- 密钥在日志/报告中脱敏（`maskKey`）。

### 报告

运行后输出到 `reports/`（可用 `--reports-dir` 改路径）：

- `compat.json` — 结构化结果与摘要
- `compat.junit.xml` — CI 集成
- `compat.md` — Markdown 兼容性报告

### 测试模式（10.4）

| 模式 | 说明 | 时机 |
| --- | --- | --- |
| Fixture Contract | `fixtures/` 固定 JSON/SSE 资产驱动 `translate()` 全链路 | 每次 PR 必跑（`--offline-only`） |
| Live Smoke | 真实 Provider 文本 / 流式 / 工具两轮 / thinking | 每日或手动 |
| 预算熔断 | `--budget` 限制请求数，达到即跳过后续 | 成本控制 |

## 目录结构

```text
llm-protocol/
├── src/                        # 协议转换核心
│   ├── formats.ts              # ApiFormat 枚举（FR-001）
│   ├── errors.ts               # 统一错误模型（FR-011）
│   ├── ir/                     # Canonical IR（纯类型）
│   │   ├── types.ts            #   request / content part / message / tool
│   │   ├── response.ts         #   response
│   │   ├── finish-reason.ts    #   统一 stop reason（FR-009）
│   │   ├── usage.ts            #   统一 usage（FR-010）
│   │   ├── fidelity.ts         #   EXACT/COMPATIBLE/LOSSY/UNSUPPORTED（FR-008）
│   │   └── policies.ts         #   转换策略（附录 A.3）
│   ├── capabilities/           # ProviderProfile（FR-007）
│   ├── codecs/
│   │   ├── protocol-adapter.ts # codec 抽象（endpoint/header/request/response/error/stream）
│   │   ├── headers.ts          # header 清洗 / allowlist
│   │   ├── registry.ts         # adapter 注册表
│   │   ├── anthropic-messages/ # Messages codec
│   │   └── openai-chat/        # Chat codec
│   ├── streams/                # SSE 状态机（M2）
│   │   ├── types.ts            #   CanonicalStreamEvent（7.1）
│   │   ├── sse-parser.ts       #   字节级 SSE 帧解析 / 编码（SR-001）
│   │   ├── validator.ts        #   事件不变量校验（SR-002）
│   │   ├── anthropic/          #   Messages SSE ↔ canonical
│   │   └── openai/             #   Chat SSE ↔ canonical
│   ├── pipeline/
│   │   ├── types.ts            # TranslateOptions / TranslationTrace
│   │   └── translate.ts        # 透明转换工厂（主 API）
│   └── index.ts                # 公共出口
├── testkit/                    # 多 Provider 测试框架（M5）
│   ├── types.ts                # ProviderConfig / Scenario / RunResult
│   ├── providers.ts            # 配置解析 / 内置三类 Provider / key 脱敏
│   ├── fixtures.ts             # fixture 加载与 mock 上游执行器
│   ├── assertions.ts           # 语义断言（10.5）
│   ├── runner.ts               # 矩阵执行器（能力门控 / 预算 / live 两轮）
│   ├── scenarios/              # 离线 Fixture + live smoke 场景
│   └── reporters/              # JSON / JUnit / Markdown 报告
├── apps/compat-runner/         # 兼容性测试 CLI（M5）
├── fixtures/                   # 离线 fixture 资产（requests/responses/streams）
└── tests/                      # vitest 单元 / 集成 / SDK smoke / 加固 / testkit 测试
```

## 设计要点

- **透明性**：调用方只看到 `from` 协议；目标协议细节（endpoint、鉴权头、`anthropic-version`）由转换器内部完成。
- **凭据安全**：key 作为不透明值在 header codec 内搬运，不进入 IR、trace 或报告。
- **SSE 独立**：非流式 codec 与 stream codec 分离，流式必须经 canonical event 状态机（start/delta/end 配对、单 terminal）。
- **能力驱动**：字段映射由 `ProviderProfile` 声明决定，不按模型名猜测。
- **报告驱动**：任何 LOSSY / UNSUPPORTED 决策都进入 `TranslationReport`，无静默丢失。

## 开发命令

```bash
npm install
npm run typecheck       # TS strict（src）
npm run typecheck:all   # src + testkit + apps 全量类型检查
npm test                # vitest，136 个用例
npm run test:coverage   # 覆盖率（语句 89%+）
npm run build           # 构建 dist/
npm run compat -- --offline-only   # 离线兼容性矩阵
```

## 里程碑状态

M0–M6 全部完成：

- **M0** Canonical IR / fidelity / error / capability 模型
- **M1** Messages ↔ Chat 非流式 codec + 透明工厂
- **M2** SSE 流式状态机（字节级解析、事件校验、实时 `Response.body`）
- **M3** Tool 全流程（并行调用、多轮回注、ID 生成上报）
- **M4** Thinking 策略（reject / drop_with_warning / provider_metadata）
- **M5** Provider testkit + compat-runner CLI + fixtures 资产
- **M6** 加固（body 限制、超时、malformed 容忍、可观测性、性能基准）

已由真实中转 Provider 验证：30 场景 live 全矩阵通过（文本 / 流式 / 工具两轮 / thinking，双向）。

**遗留项**：`openai-responses` adapter（P1）；live Provider 实测建议覆盖官方 Anthropic / OpenAI 与多家第三方；分支覆盖率 73%（语句已超 85% 目标）。
