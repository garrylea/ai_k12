# AI-Agent 中枢 MVP 开发计划

> 版本：v1.0
> 日期：2026-07-23
> 依据：[K12智学系统-AI-Agent中枢设计文档](../K12智学系统-AI-Agent中枢设计文档.md)
> 对应设计文档：[K12智学系统-AI-Agent中枢设计文档](../K12智学系统-AI-Agent中枢设计文档.md)

---

## 1. 概述

本计划覆盖 AI-Agent 中枢 **MVP 阶段**（设计文档 §10.1）的全部开发工作，采用混合式里程碑组织：先建核心基础设施，再按业务优先级垂直切片交付。

### 1.1 范围

| 包含 | 不包含 |
|------|--------|
| infra 6 组件全量 | 语文/英语 Prompt 模板（P1） |
| capabilities 5 能力全量 | 变式题校验（P1） |
| 数学学科全部 Prompt 模板 | 熔断器 circuit breaker（P1） |
| ConversationService 骨架 | 作文批改（P1） |
| 可观测性 + 回归测试框架 | 跨节点会话续接（P1） |
| | 微服务拆分 / 语音 / 知识图谱（P2） |

### 1.2 里程碑总览

```
M1: 核心基础设施 ──► M2: 辅导能力 ──► M3: 评估能力 ──► M4: 内容生成 + 收尾
 (共用底座+骨架)     (首个端到端)      (批改+解析)      (变式+报告+监控)
```

### 1.3 前置条件

- [x] AI-Agent 中枢设计文档已完成
- [ ] `apps/server/` 项目初始化（Node.js + TypeScript + 包管理）
- [ ] 至少一个 LLM 厂商 API Key 可用（推荐 Qwen 或 DeepSeek 起步）
- [ ] 设计文档中附录 A 的完整 Prompt 模板文本准备就绪

---

## 2. Milestone 1：核心基础设施

**目标**：建好所有 capabilities 共用的底层组件。不涉及任何业务能力。

**预估文件数**：~12 个源文件 + 4 个配置文件 + 1 个类型文件

### 2.1 交付物清单

#### 2.1.1 配置体系

| 文件 | 内容 |
|------|------|
| `apps/server/src/ai-core/config.yaml` | 全局配置入口（引用子配置文件） |
| `apps/server/src/ai-core/model-routes.yaml` | 模型路由表（设计文档附录 C.1） |
| `apps/server/src/ai-core/retry.yaml` | 重试与超时配置（设计文档附录 C.2） |
| `apps/server/src/ai-core/safety.yaml` | 安全检测配置（设计文档附录 C.3） |
| `apps/server/src/ai-core/config-loader.ts` | YAML 加载 + 环境变量 `${VAR}` 注入 |

#### 2.1.2 ModelRouter

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/infra/model-router.ts` | `route(request: RouteRequest): RouteResult` — 路由表匹配（scene+subject+difficulty），降级匹配链（精确→去difficulty→通配subject→默认），主备模型选择 |

**接口**：`RouteRequest` / `RouteResult` / `ModelConfig`（设计文档 §3.1.2）

#### 2.1.3 PromptBuilder

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/infra/prompt-builder.ts` | `build(request: PromptBuildRequest): PromptBuildResult` — 模板路径解析→加载（带缓存）→公共片段合并→Mustache 变量注入→消息数组构建→token 估算 |

**接口**：`PromptBuildRequest` / `PromptContext` / `PromptBuildResult` / `ChatMessage`（设计文档 §3.2.3）

#### 2.1.4 ModelClient

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/infra/model-client/index.ts` | 统一入口 `chat()` / `streamChat()`，重试逻辑（2次+指数退避），错误码映射 |
| `apps/server/src/ai-core/infra/model-client/kimi-client.ts` | Kimi API 适配（OpenAI 兼容） |
| `apps/server/src/ai-core/infra/model-client/qwen-client.ts` | Qwen API 适配（OpenAI 兼容） |
| `apps/server/src/ai-core/infra/model-client/deepseek-client.ts` | DeepSeek API 适配（OpenAI 兼容） |
| `apps/server/src/ai-core/infra/model-client/gemini-client.ts` | Gemini API 适配（MVP 可 stub，数学难题场景才需要） |

**接口**：`ChatRequest` / `ChatResponse` / `StreamChunk` / `ModelErrorCode` / `ModelClientError` / `RetryConfig`（设计文档 §3.3.3-§3.3.5）

#### 2.1.5 ResponseParser

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/infra/response-parser.ts` | `parse<T>(request: ParseRequest): ParseResult<T>` — text/latex/json/hybrid 四种模式分发，JSON 三级容错（直接解析→```json 提取→常见错误修复），Zod schema 校验 |

**接口**：`ParseRequest` / `ParseResult` / `ParseMode` / `GradingResult` / `StepGrade`（设计文档 §3.5.3-§3.5.4）

#### 2.1.6 类型定义

| 文件 | 内容 |
|------|------|
| `apps/server/src/ai-core/types.ts` | 全部 DTO 接口、枚举、错误码的集中定义（设计文档附录 B.1） |

#### 2.1.7 ConversationService 骨架

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/services/conversation/index.ts` | 内存版实现（暂不接 DB） |
| `apps/server/src/services/conversation/types.ts` | `LoadContextRequest/Response`、`SaveMessagesRequest`、`UpdateFailCountRequest`、`CompleteDialogueRequest`（设计文档 §6.1.2） |

**骨架行为**：
- `loadContext()` — 返回内存 Map 中存储的对话历史 + 固定学生信息
- `saveMessages()` — 追加到内存 Map
- `updateFailCount()` — 修改内存计数器
- `completeDialogue()` — 标记对话状态

### 2.2 验收标准

1. `ModelRouter.route({scene:'tutoring', subject:'math', difficulty:2})` → `{primary: 'qwen-3.7-max', fallback: 'deepseek-v4-flash'}`
2. `ModelRouter.route({scene:'safety', subject:'math'})` → `{primary: 'deepseek-v4-flash', fallback: undefined}`（安全检测无备选）
3. `PromptBuilder.build({capability:'tutoring', subject:'math', track:'mainline', context:{...}})` → 完整 `ChatMessage[]`（含 system + user 消息）
4. `ModelClient.chat({model, messages})` → 对 Kimi/Qwen/DeepSeek 任一厂商发起真实 API 调用并返回 `ChatResponse`
5. `ModelClient.streamChat()` → 返回 `AsyncIterable<StreamChunk>`
6. `ResponseParser.parse({rawContent:'...', mode:'json', schema})` → 容错解析 + Zod 校验通过
7. `ConversationService.loadContext(dialogueId)` → 返回对话历史 + 学生上下文
8. 配置文件通过环境变量注入 API Key，不在代码中硬编码

### 2.3 依赖

- **外部**：`apps/server/` 项目骨架（`package.json`、`tsconfig.json`、目录结构）
- **内部**：无（Milestone 1 无上游依赖）
- **API Key**：至少 1 个厂商可用（推荐 DeepSeek，最便宜，适合开发测试）

---

## 3. Milestone 2：辅导能力（首个端到端对话流程）

**目标**：跑通"学生发消息 → AI 苏格拉底式回复"全链路。

**预估文件数**：~10 个源文件 + 7 个 Prompt 模板

### 3.1 交付物清单

#### 3.1.1 SafetyGuard

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/infra/safety-guard.ts` | `check(request: SafetyCheckRequest): SafetyCheckResult` — 调用分类模型（DeepSeek-V4-Flash）→ 三层判定（learning 放行 / off_topic 闲聊处置 / anomaly 异常处置），连续闲聊升级计数，温和阻断话术选择 |

**接口**：`SafetyCheckRequest` / `SafetyCheckResult` / `SafetyAlert`（设计文档 §3.4.3）

**话术选择逻辑**：
- `off_topic` → 从 `gentle-block.yaml` 的 `off_topic` 列表随机选择
- `emotional` → 从 `emotional` 列表选择
- `sensitive` → 固定话术 + critical 预警

#### 3.1.2 FallbackHandler

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/infra/fallback-handler.ts` | `handle(request: FallbackRequest): FallbackResponse` — 建兜底 Prompt → 调用模型 → 解析为结构化兜底响应（温和开场+分步解析+知识点总结+学习建议） |

**接口**：`FallbackRequest` / `FallbackResponse`（设计文档 §3.6.3）

**触发规则**：
- `context.consecutiveFailCount >= 3` → 自动触发
- `message` 匹配关键词（不会/不懂/不知道/太难/放弃/算不出来/想不出来）→ 立即触发
- 按知识点维度管理失败计数（切知识点重置）

#### 3.1.3 TutoringCapability

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/capabilities/tutoring.capability.ts` | 9 步主流程（设计文档 §4.1.5）+ `isGiveUpMessage()` 关键词检测 |

**双模式差异**（设计文档 §4.1.2）：
- **主线**：严格限定卡片范围（cardId 必传），不计错题，Prompt 用 `mainline.md`
- **辅线**：开放范围，计入 `aux_error_books`，Prompt 用 `auxiliary.md`

#### 3.1.4 Prompt 模板

| 文件 | 用途 |
|------|------|
| `prompts/system/base.md` | 通用角色设定（设计文档 §5 结构） |
| `prompts/system/socratic-rules.md` | 苏格拉底规则片段（设计文档 §5.7.1） |
| `prompts/system/safety-rules.md` | 安全边界规则片段 |
| `prompts/tutoring/math/mainline.md` | 数学主线辅导（设计文档 §5.4.1） |
| `prompts/tutoring/math/auxiliary.md` | 数学辅线辅导（设计文档 §5.4.2） |
| `prompts/safety/classifier.md` | 内容分类器（设计文档 §5.8.1） |
| `prompts/safety/gentle-block.yaml` | 温和阻断话术库（设计文档 §5.8.2） |
| `prompts/fallback/full-explanation.md` | 兜底完整解析（设计文档 §5.8.3） |

#### 3.1.5 ConversationService 升级

| 变更 | 说明 |
|------|------|
| 上下文截断 |当历史消息超过 tokenBudget：保留最后 4 条 + 早期消息摘要压缩（每 6 对合并） |
| 失败计数 | 按知识点维度（非对话维度），`updateFailCount(dialogueId, increment, knowledgePointId)` |
| 消息类型 | 保存时区分 `type: 'socratic' \| 'fallback' \| 'block'` |

### 3.2 验收标准

1. **主线辅导**：传入 cardContent + "这个方程怎么解" → AI 不直接给答案，通过提问引导（如"你注意到等式两边有什么共同点？"）
2. **辅线辅导**：传入 "我想问一下勾股定理" → AI 开放范围引导，不限定卡片
3. **闲聊阻断**：输入 "今天天气真好" → 温和阻断话术（如"我是你的学习小助手哦～"）
4. **连续闲聊升级**：同一对话第 3 次闲聊 → alertLevel='warning'，第 5 次 → 'critical'
5. **兜底触发**：同一知识点连续 3 次回答错误 → 输出完整解析（4 段结构）
6. **放弃触发**：输入 "太难了我不会" → 立即触发兜底
7. **流式传输**：`streamChat()` 首字延迟 < 3s
8. **消息持久化**：每轮对话的 user/assistant 消息正确存入 ConversationService

### 3.3 依赖

- **上游**：Milestone 1 全部组件
- **外部**：Qwen API Key（数学辅导主模型）或 DeepSeek API Key（备选/降级）

---

## 4. Milestone 3：评估能力（批改 + 解析闭环）

**目标**：在对话能力之上，叠加"做题→批改→错题解析"完整闭环。

**预估文件数**：~4 个源文件 + 4 个 Prompt 模板

### 4.1 交付物清单

#### 4.1.1 GradingCapability

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/capabilities/grading.capability.ts` | `grade(request: GradingRequest): GradingResult` — 路由（grading scene）→ 建批改 Prompt → 调模型（`responseFormat: 'json_object'`）→ ResponseParser 解析 → 总分合理性检查 |

**接口**：`GradingRequest`（设计文档 §4.2.3）

**题型支持**（MVP 仅数学）：
- 证明题 → `math-proof.md`
- 计算题/解答题 → `math-calculation.md`

**总分检查**：步骤分之和 vs `totalScore`，偏差 > 20% 则重新请求（最多 1 次）

#### 4.1.2 ExplanationCapability

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/capabilities/explanation.capability.ts` | `explain(request: ExplanationRequest): ExplanationResponse` — 按 mode 分发：`error_analysis`（错题解析）/ `knowledge_retry`（知识点重讲） |

**接口**：`ExplanationRequest`（设计文档 §4.3.3）

#### 4.1.3 Prompt 模板

| 文件 | 用途 |
|------|------|
| `prompts/grading/math-proof.md` | 数学证明题批改（设计文档 §5.8.4 + 附录 A.7） |
| `prompts/grading/math-calculation.md` | 数学计算题批改（设计文档附录 A.8） |
| `prompts/explanation/error-analysis.md` | 错因分析 + 分步解析（设计文档附录 A.17） |
| `prompts/explanation/knowledge-retry.md` | 知识点重讲（设计文档附录 A.18） |

### 4.2 验收标准

1. 传入一道数学证明题 + 学生作答 → 返回 `GradingResult`（每步 isCorrect + score + comment）
2. 传入一道数学计算题 + 学生作答 → 返回按关键步骤（设未知数/列式/计算/作答）的评分
3. 步骤分之和与 `totalScore` 偏差 > 20% → 自动重请求修正
4. 传入错题 + 学生错误答案 → 返回错因分析（概念不清/计算粗心/审题不准）+ 分步解析
5. 传入知识点 + 多次错误历史 → 返回知识点重讲（换角度、换方式）
6. JSON 解析失败时降级为 text 模式（不中断流程）

### 4.3 依赖

- **上游**：Milestone 2（ConversationService 升级版 + SafetyGuard + ResponseParser）
- **外部**：同 Milestone 2

---

## 5. Milestone 4：内容生成 + 收尾

**目标**：补齐剩余能力 + 可观测性，MVP 整体交付就绪。

**预估文件数**：~4 个源文件 + 2 个 Prompt 模板 + 测试框架

### 5.1 交付物清单

#### 5.1.1 VariationCapability

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/capabilities/variation.capability.ts` | `generate(request: VariationRequest): VariationResponse` — 路由（variation scene）→ 建 Prompt → 调模型（`responseFormat: 'json_object'`）→ 解析变式题数组 |

**接口**：`VariationRequest` / `VariationResponse` / `VariationQuestion`（设计文档 §4.4.4）

**变式类型**：换数 / 换场景 / 调整条件（设计文档 §4.4.3）

**MVP 限定**：不做校验阶段，直接信任生成结果。校验预留代码注释 + `featureFlags.variationValidation` 开关。

#### 5.1.2 AnalyticsCapability

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/capabilities/analytics.capability.ts` | `generateReport(request: AnalyticsRequest): AnalyticsResponse` — 路由（analysis scene → Kimi）→ 注入统计数据 → 调模型 → 解析为结构化报告 |

**接口**：`AnalyticsRequest` / `AnalyticsResponse`（设计文档 §4.5.2-§4.5.3）

#### 5.1.3 Prompt 模板

| 文件 | 用途 |
|------|------|
| `prompts/variation/generate.md` | 变式题生成（设计文档附录 A.11） |
| `prompts/analytics/report.md` | 学情报告生成（设计文档附录 A.16） |

#### 5.1.4 可观测性

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/infra/logger.ts` | 结构化 JSON 日志（`AgentLog` 接口，含 traceId 贯穿全链路） |
| `apps/server/src/ai-core/infra/metrics.ts` | Prometheus 指标注册 + 埋点（设计文档 §9.2 的 8 个指标） |

**埋点位置**：
- `ai_agent_request_total` — ModelClient 每次调用后 +1
- `ai_agent_request_duration_ms` — ModelClient 记录 latency
- `ai_agent_token_consumption` — ModelClient 记录 usage
- `ai_agent_cost_total` — 按 parentId 累计费用
- `ai_agent_error_total` — ModelClient catch 块
- `ai_agent_fallback_total` — FallbackHandler.handle() 调用时
- `ai_agent_safety_block_total` — SafetyGuard.shouldBlock=true 时

#### 5.1.5 回归测试框架

| 文件 | 关键实现 |
|------|----------|
| `apps/server/src/ai-core/__tests__/grading-accuracy.ts` | 30 道固定数学题 + 人工标注标准评分 → AI 评分对比 |
| `apps/server/src/ai-core/__tests__/tutoring-quality.ts` | 20 组"错误答案 → AI 引导"场景 → 输出供人工评估 |
| `apps/server/src/ai-core/__tests__/safety-classification.ts` | 100 条标注样本 → 分类准确率对比 |

### 5.2 验收标准

1. 传入原题（如"小明买 3 支笔花 12 元…"）→ 返回 1-2 道同知识点变式题（含答案+解析）
2. 变式题与原题考查同一知识点、难度一致
3. 传入学习统计数据 → 返回结构化报告（summary + highlights + weakPointAnalysis + suggestions + encouragement）
4. 每次 AI 调用的日志含 traceId，可从 ModelRouter → PromptBuilder → ModelClient 串联
5. Prometheus `ai_agent_request_total` 指标按 scene+model+subject 正确分组
6. 回归测试脚本可执行并输出对比报告

### 5.3 依赖

- **上游**：Milestone 3（GradingCapability 的 `GradingResult` 供测试框架使用）
- **外部**：Prometheus endpoint 可用（本地开发可选）

---

## 6. 跨里程碑关注点

### 6.1 测试策略

| 层级 | 时机 | 内容 |
|------|------|------|
| 单元测试 | 每个组件实现后立即写 | 路由匹配逻辑、JSON 解析容错、兜底关键词匹配、模板变量注入 |
| 集成测试 | 每个 Milestone 结束时 | 完整链路：路由→建 Prompt→调模型→解析 |
| 回归测试 | Milestone 4 | 固定题集评测（§5.1.5） |

### 6.2 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| LLM API 不稳定/延迟高 | 辅导首字延迟 > 3s | 主备模型自动切换已在 ModelClient 中实现 |
| 模型输出格式不符合预期 | JSON 解析失败 | ResponseParser 三级容错 + defaultResult 兜底 |
| API Key/额度问题 | 开发停滞 | 优先用 DeepSeek（最便宜），备选 Qwen |
| Prompt 调优周期长 | 辅导质量不达标 | Prompt 模板与代码分离，可独立迭代 |

### 6.3 目录结构（预期最终态）

```text
apps/server/
├── src/
│   ├── ai-core/
│   │   ├── infra/
│   │   │   ├── model-router.ts
│   │   │   ├── prompt-builder.ts
│   │   │   ├── model-client/
│   │   │   │   ├── index.ts
│   │   │   │   ├── kimi-client.ts
│   │   │   │   ├── qwen-client.ts
│   │   │   │   ├── gemini-client.ts
│   │   │   │   └── deepseek-client.ts
│   │   │   ├── safety-guard.ts
│   │   │   ├── response-parser.ts
│   │   │   ├── fallback-handler.ts
│   │   │   ├── logger.ts
│   │   │   └── metrics.ts
│   │   ├── capabilities/
│   │   │   ├── tutoring.capability.ts
│   │   │   ├── grading.capability.ts
│   │   │   ├── explanation.capability.ts
│   │   │   ├── variation.capability.ts
│   │   │   └── analytics.capability.ts
│   │   ├── prompts/
│   │   │   ├── system/
│   │   │   │   ├── base.md
│   │   │   │   ├── socratic-rules.md
│   │   │   │   └── safety-rules.md
│   │   │   ├── tutoring/
│   │   │   │   └── math/
│   │   │   │       ├── mainline.md
│   │   │   │       └── auxiliary.md
│   │   │   ├── grading/
│   │   │   │   ├── math-proof.md
│   │   │   │   └── math-calculation.md
│   │   │   ├── explanation/
│   │   │   │   ├── error-analysis.md
│   │   │   │   └── knowledge-retry.md
│   │   │   ├── variation/
│   │   │   │   └── generate.md
│   │   │   ├── safety/
│   │   │   │   ├── classifier.md
│   │   │   │   └── gentle-block.yaml
│   │   │   ├── fallback/
│   │   │   │   └── full-explanation.md
│   │   │   └── analytics/
│   │   │       └── report.md
│   │   ├── types.ts
│   │   ├── config.yaml
│   │   ├── model-routes.yaml
│   │   ├── retry.yaml
│   │   ├── safety.yaml
│   │   ├── fallback.yaml
│   │   ├── quota.yaml
│   │   └── observability.yaml
│   ├── services/
│   │   └── conversation/
│   │       ├── index.ts
│   │       └── types.ts
│   └── ...
└── package.json
```

---

## 7. 下一步

本计划经确认后，将通过 `superpowers:writing-plans` 技能生成详细的实现计划（含每个文件的具体实现步骤、函数签名、测试用例清单）。
