# AGENTS.md — llm-protocol

Clean-room LLM 协议转换内核（Anthropic Messages ↔ OpenAI Chat）。规格见 [`docs/tech.md`](docs/tech.md)（v0.5）。本文件补充项目级约定；全局规则（安全边界、开发分支、提交规范）遵循 `/Users/tongyulong/.pi/agent/AGENTS.md`，两者冲突时以更严格者为准。

## 项目结构

```text
llm-protocol/
├── src/                        # 协议转换核心（发布产物 dist/ 仅来自此目录）
│   ├── formats.ts              # ApiFormat 枚举（FR-001）
│   ├── errors.ts               # 统一错误模型（FR-011）
│   ├── ir/                     # Canonical IR（纯类型，无运行时逻辑）
│   │   ├── types.ts            #   request / content part / message / tool
│   │   ├── response.ts         #   response
│   │   ├── finish-reason.ts    #   统一 stop reason（FR-009）
│   │   ├── usage.ts            #   统一 usage（FR-010）
│   │   ├── fidelity.ts         #   EXACT/COMPATIBLE/LOSSY/UNSUPPORTED（FR-008）
│   │   └── policies.ts         #   转换策略（附录 A.3）
│   ├── capabilities/           # ProviderProfile（FR-007，纯类型）
│   ├── codecs/                 # 协议 codec（每协议一个目录）
│   │   ├── protocol-adapter.ts #   codec 抽象（endpoint/header/request/response/error/stream）
│   │   ├── headers.ts          #   header 清洗 / allowlist 公共逻辑
│   │   ├── registry.ts         #   adapter 注册表
│   │   ├── anthropic-messages/ #   Messages codec（endpoint/header/request/response/error/index）
│   │   └── openai-chat/        #   Chat codec
│   ├── streams/                # SSE 状态机（M2）
│   │   ├── types.ts            #   CanonicalStreamEvent（7.1）
│   │   ├── sse-parser.ts       #   字节级 SSE 帧解析 / 编码（SR-001）
│   │   ├── validator.ts        #   事件不变量校验（SR-002）
│   │   ├── anthropic/          #   Messages SSE ↔ canonical（parse.ts/render.ts）
│   │   └── openai/             #   Chat SSE ↔ canonical（parse.ts/render.ts）
│   ├── pipeline/               # 主 API
│   │   ├── types.ts            #   TranslateOptions / TranslationTrace
│   │   └── translate.ts        #   translate() 透明转换工厂（唯一公开入口）
│   └── index.ts                # 公共出口
├── testkit/                    # 多 Provider 测试框架（M5，不随包发布）
│   ├── types.ts                # ProviderConfig / Scenario / RunResult
│   ├── providers.ts            # 配置解析 / 内置三类 Provider / key 脱敏
│   ├── fixtures.ts             # fixture 加载与 mock 上游执行器
│   ├── assertions.ts           # 语义断言（10.5）
│   ├── runner.ts               # 矩阵执行器（能力门控 / 预算 / live 两轮）
│   ├── scenarios/              # 离线 Fixture + live smoke 场景
│   └── reporters/              # JSON / JUnit / Markdown 报告
├── apps/compat-runner/         # 兼容性测试 CLI（M5，不随包发布）
├── fixtures/                   # 离线 fixture 资产（requests/responses/streams）
├── tests/                      # vitest 测试
├── docs/tech.md                # 需求规格（权威来源）
├── .github/workflows/          # publish-npm.yml（Trusted Publishing）
└── package.json                # private 已移除；publishConfig 固定 npmjs 公共源
```

**架构边界（必须遵守）**：
- 一切转换经 **Canonical IR**，禁止编写大量 A→B 直接映射。
- 凭据（API key）只能作为不透明值在 header codec 内搬运，**禁止**进入 IR、trace、报告或日志。
- 流式必须经 canonical event 状态机（start/delta/end 配对、单 terminal），禁止逐 JSON chunk 无状态改写。
- 无静默降级：任何 LOSSY/UNSUPPORTED 决策必须产生 TranslationReport warning。
- 映射决策由 `ProviderProfile` 能力声明驱动，禁止按模型名猜测。
- `src/` 之外的目录（testkit/apps/fixtures）不进入发布包（`files: ["dist"]`）。

## 单测规范

框架：**Vitest**（`vitest.config.ts`，`tests/**/*.test.ts`）。Node 内置 Fetch / Web Streams / AbortSignal，测试优先用真实 `Request`/`Response` + 注入 mock `fetch`。

### 必跑命令

```bash
npm run typecheck       # src 严格类型检查
npm run typecheck:all   # src + testkit + apps 全量
npm test                # 全部单元/集成/SDK smoke/testkit 测试
npm run test:coverage   # 语句覆盖率 ≥85%（NFR-009）
npm run compat -- --offline-only   # 离线 fixture 矩阵（必跑，不打真实 API）
```

### 规范

1. **走公开 API**：端到端用例必须通过 `translate()` 工厂（输入标准 `Request`，输出标准 `Response`），不绕过主 API 只测底层 codec；底层 codec 单独测试放同目录。
2. **测试文件命名** `*.test.ts`，按主题划分：`formats / codecs / cross-render / pipeline / pipeline-errors / streams / streams-edge / streaming-e2e / tooling-e2e / policies / hardening / sdk-smoke / testkit`。
3. **每个里程碑/需求映射到测试**：新增需求时，先写覆盖验收条件的测试（失败）→ 实现 → 通过。离线 fixture 优先（不打真实 API）。
4. **live 场景纪律**：live 测试只在 `testkit/` 中通过 `compat-runner` 运行，**禁止**放进 `tests/` 的普通单测（会因无 key/网络不可用而破坏 CI）。无 key 时必须 skip 而非 fail。
5. **断言纪律**：
   - 流式断言用 `createSSEParser` 聚合帧，断言 start/delta/end 配对、`message_end` 单次、index 一致。
   - 工具参数最终必须可 `JSON.parse`（TR-003）。
   - Thinking 只断言结构/顺序/opaque 连续性，**禁止**断言私有推理正文。
   - 任何 lossy 转换断言对应 warning 出现在 trace 中。
   - 敏感断言：trace/report 序列化后不得包含 API key、Authorization、完整 prompt。
6. **不新增脆弱时序测试**：性能基准用宽松守卫（本地 p95 <50ms），避免 CI 抖动 flaky。
7. **改动自检**：提交前跑 `typecheck:all` + `npm test` + `npm run compat -- --offline-only`（18 场景全过）。覆盖率下降需说明。

## 版本 bump 规范

使用 `npm version` 管理版本号，**禁止**手改 `package.json` 的 version 字段。

- 仓库已配置 `publishConfig`（npmjs 公共源）与 `.github/workflows/publish-npm.yml`（`v*` tag 触发 Trusted Publishing 发布）。
- 本地发布 `publish:local` 会先 `npm version patch --no-git-tag-version`（本地 patch bump，不提交不打 tag）再发布到本地 registry（`http://localhost:9007`），因此工作区可能出现未提交的 version 变更。
- **发现版本变更不要回滚**：若工作区已存在 version 变更（例如来自 `publish:local`），禁止将其改回 HEAD 上的旧版本，应在当前版本基础上继续 bump。

### 流程

```bash
# 1. 确认在 main（或合并后的发布分支）且工作区干净
git status

# 2. 语义化 bump（自动更新 package.json + package-lock.json + 生成 commit + tag）
npm version patch   # 修复（bugfix）
npm version minor   # 新功能（feature，向后兼容）
npm version major   # 破坏性变更

# 3. 推 tag 触发发布 workflow
git push origin main --tags
```

- `npm version <major|minor|patch>` 自动：更新 version → 提交 → 打 `vX.Y.Z` tag。
- 也可显式指定版本：`npm version 1.2.3`。
- `--no-git-tag-version`：只改文件不提交不打 tag（用于 CI 内对齐，见 publish workflow）。
- 发布 workflow 会再次从 tag 同步版本（`npm version "$VERSION" --no-git-tag-version --allow-same-version`），本地与 tag 必须一致。
- 预发布版本（如 `1.0.0-rc.1`）→ `npm version prerelease` 或 `npm version 1.0.0-rc.1`。
- 版本号必须符合 `v[0-9]+.[0-9]+.[0-9]+*` 才能触发发布 action。
