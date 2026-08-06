# fixtures 资产说明

离线 fixture 资产：requests / responses / streams，供 testkit 的 Fixture Contract 模式与回归测试使用。

- 每个 fixture 是官方协议原始形态（`from` 或 `to` 协议均可）。
- SSE fixture 为逐字节 SSE 文本，保持官方事件顺序，可直接作为 `Response.body` 喂给 `translate()`。
- 来源见各文件 `source`/`description` 字段（对应测试或 tech.md 示例）。

## 覆盖

| 目录 | fixture | 用途 |
| --- | --- | --- |
| requests/ | anthropic-text / anthropic-tool / openai-text / openai-tool | Fixture Contract 请求侧 |
| responses/ | anthropic-text / anthropic-tool / openai-text / openai-tool / openai-error | 非流式响应与错误反向转换 |
| streams/ | anthropic-text / anthropic-tool / anthropic-thinking / openai-text / openai-tool | 流式 Fixture Contract 与 SDK 解析 |

新增兼容性修复时，先落最小复现 fixture 到 regressions/（尚未建立），再独立修复（技术规范 3「Fixture 资产化」）。
