# llm-protocol

[English](README.md) | **简体中文**

独立实现的 LLM 协议转换内核：**Anthropic Messages ↔ OpenAI Chat** 双向请求/响应/流式转换，输入输出均为 Node.js 标准 `Request` / `Response`，可嵌入任何 HTTP 框架。

## 特性

| 能力 | 支持 |
| --- | --- |
| 协议 | Anthropic Messages ↔ OpenAI Chat |
| 模式 | 非流式 JSON、SSE 流式 |
| 内容 | system / 多轮文本 / 图片 / Tool 定义 / Tool 调用 / Tool 结果 / 多轮回注 / 并行调用 |
| Thinking | thinking / redacted_thinking / signature 双向映射，三策略：reject / drop_with_warning / provider_metadata |
| 状态 | usage、finish/stop reason、ID、model、错误反向转换 |
| 安全 | 凭据不透明搬运、header 清洗、body 大小限制、超时、取消传播、trace 脱敏 |

**暂不支持**：OpenAI Responses 格式 `openai-responses`。

## 快速开始

### 安装

```bash
npm install llm-protocol
```

Node.js ≥ 20。

### 使用示例

```ts
import { translate } from "llm-protocol";

// 创建「OpenAI Chat 客户端 → Anthropic 上游」的转发器
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

返回的 `Response` 恢复为 OpenAI Chat 协议。URL 改写、鉴权头、`anthropic-version`、body 转换与响应反向转换全部在工厂内部完成。

### SSE 流式示例

设置 `stream: true`，响应 body 即为实时 `ReadableStream`。

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

// 响应 body 为 OpenAI Chat SSE，逐帧消费
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

## 证书

MIT
