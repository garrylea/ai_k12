# K12 智学系统 — AI-Agent 中枢设计文档

> 版本：v1.0
> 对应文档：
> - [K12智学系统-产品需求文档.md](./K12智学系统-产品需求文档.md)（以下简称 PRD）
> - [K12智学系统-架构设计文档.md](./K12智学系统-架构设计文档.md)（以下简称架构文档，§4.2.1 定义 AI-Agent 中枢高层结构）
> - [K12智学系统-AI辅导流程详细设计.md](./K12智学系统-AI辅导流程详细设计.md)
> - [API接口与数据流设计文档.md](./API接口与数据流设计文档.md)

---

## 1. 文档说明

### 1.1 目的与范围

本文档是 K12 智学系统「AI-Agent 中枢」的独立设计文档，承接架构文档 §4.2.1 的高层描述，细化到组件级实现方案、Prompt 模板体系、接口协议与调用边界，为 `apps/server/ai-core/` 的开发和后续演进提供技术基准。

**本文档覆盖**：
- 基础设施层（infra）6 个组件的详细设计：ModelRouter、PromptBuilder、ModelClient、SafetyGuard、ResponseParser、FallbackHandler
- 能力层（capabilities）5 个能力的详细设计：TutoringCapability、GradingCapability、ExplanationCapability、VariationCapability、AnalyticsCapability
- 多学科并行的完整 Prompt 模板体系（数学 / 语文 / 英语，共 18+ 个模板）
- 与业务服务（ConversationService、Assessment、Practice/Training、ParentAdmin）的交互协议
- 模型路由策略、成本配额控制、可观测性与质量监控
- 完整的 TypeScript 接口 DTO 定义和 YAML 配置项清单

**本文档不覆盖**：
- 业务服务的内部实现（ConversationService、Assessment Service 等归各自文档或 API 文档）
- 前端 AI 对话组件（归 UX-UI 文档）
- Data Refinery 管线内部（归架构文档 §4.2.3）

### 1.2 术语表

| 术语 | 英文 | 定义 |
|------|------|------|
| AI-Agent 中枢 | AI-Agent Hub | 系统的通用智能能力层模块，提供 AI 推理、辅导、批改、分析等能力 |
| 基础设施层 | infra | 共用、薄、无业务状态的基础组件 |
| 能力层 | capabilities | 调用 infra 组合实现的业务编排能力 |
| 苏格拉底辅导 | Socratic Tutoring | 不直接给答案、通过提问引导思考的 AI 辅导方式 |
| 主线 | Mainline | 按教材章节顺序的课程闯关学习轨道 |
| 辅线 | Auxiliary | 自由探索、答疑的辅助学习轨道 |
| 兜底 | Fallback | 学生连续失败后的完整解析输出机制 |
| 温和阻断 | Gentle Block | 对非学习内容不严厉封禁、亲切引导回学习的策略 |
| 变式题 | Variation Question | 与原题同知识点、不同数值或场景的衍生题目 |

### 1.3 与上游文档的关系

```text
PRD（产品需求文档）
  │
  ├── §7.1 AI 辅导引擎 ────────► 本文档 §4.1 TutoringCapability
  ├── §7.5 自动判题 ───────────► 本文档 §4.2 GradingCapability
  ├── §7.9 异常兜底 ───────────► 本文档 §3.4 SafetyGuard + §3.6 FallbackHandler
  ├── §7.10 变式题生成 ────────► 本文档 §4.4 VariationCapability
  └── §7.4 错题本 ────────────► 本文档 §6.3 与错题写入方（practice/training/exams）的协作

架构文档 §4.2.1（AI-Agent 中枢高层定义）
  │
  └── 两层结构 infra + capabilities ──► 本文档 §2-§4（细化至组件级）

AI 辅导流程详细设计（苏格拉底状态机、话术策略）
  │
  └── 辅导状态机与边界规则 ────► 本文档 §4.1 TutoringCapability（细化实现）

API 设计文档 §4.7 AI 接口
  │
  └── 端点契约 ───────────────► 本文档 §6（细化 Agent 中枢侧的处理协议）
```

---

## 2. 架构总览

### 2.1 两层架构定位

AI-Agent 中枢是 K12 智学系统后端内部的**通用智能能力层模块**，采用「基础设施层 + 能力层」两层结构，单进程模块化部署。

**三个核心原则**：

1. **不直接接收用户请求**：AI-Agent 中枢只输出智能结果，所有用户请求由业务服务（Content/Assessment 等）接入
2. **不持有业务数据**：对话流水归 ConversationService（架构文档 §4.2.10），AI-Agent 中枢自身无状态
3. **不绑定展示型服务**：ParentAdmin 等展示层只读 AI-Agent 产出的结论，Agent 中枢不感知展示逻辑

**两层结构总览**：

```text
┌─────────────────────────────────────────────────────────────┐
│                    AI-Agent 中枢（ai-core/）                   │
├─────────────────────────────────────────────────────────────┤
│  capabilities/  能力层（业务编排，调用 infra）                   │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │  Tutoring   │ │   Grading   │ │  Variation  │            │
│  │ Capability  │ │ Capability  │ │ Capability  │            │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘            │
│  ┌──────┴──────┐ ┌──────┴──────┐                                  │
│  │Explanation │ │ Analytics  │                                  │
│  │Capability  │ │Capability  │                                  │
│  └──────┬──────┘ └──────┬──────┘                                  │
│         └───────────────┴────────────────────────────────      │
│                          │                                      │
│  ┌───────────────────────┴────────────────────────────────┐    │
│  │  infra/  基础设施层（共用、薄、无业务状态）                │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │    │
│  │  │  Model   │ │  Prompt  │ │  Model   │ │  Safety  │  │    │
│  │  │  Router  │ │  Builder │ │  Client  │ │  Guard   │  │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │    │
│  │  ┌──────────┐ ┌──────────┐                             │    │
│  │  │ Response │ │ Fallback │                             │    │
│  │  │  Parser  │ │ Handler  │                             │    │
│  │  └──────────┘ └──────────┘                             │    │
│  └────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 模块依赖关系

```text
                    ┌──────────────────────────────┐
                    │     ConversationService      │
                    │   (外部服务，上下文管理)        │
                    └─────────────┬────────────────┘
                                  │ loadContext / saveMessages
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                        capabilities                              │
│                                                                  │
│  TutoringCapability ──► ModelRouter ──► PromptBuilder ──► ModelClient
│        │                     │                │                │
│        ├──► SafetyGuard      │                │                │
│        ├──► FallbackHandler  │                │                │
│        └──► ResponseParser   │                │                │
│                              │                │                │
│  GradingCapability ──► ModelRouter ──► PromptBuilder ──► ModelClient
│        │                                            │
│        └──► ResponseParser                          │
│                                                     │
│  VariationCapability ──► ModelRouter ──► PromptBuilder ──► ModelClient
│                                                     │
│  ExplanationCapability ──► ModelRouter ──► PromptBuilder ──► ModelClient
│                                                     │
│  AnalyticsCapability ──► ModelRouter ──► PromptBuilder ──► ModelClient
└─────────────────────────────────────────────────────────────────┘
```

**依赖规则**：
- capabilities 只能调用 infra 层组件，不能跨 capability 调用
- infra 层组件之间可以互相调用（如 SafetyGuard 用 ModelClient 做分类）
- 所有 capabilities 通过 ConversationService 读写对话上下文，不直接访问数据库

### 2.3 部署模式

**MVP 阶段（当前设计目标）**：
- AI-Agent 中枢作为 `apps/server/` 内的 `ai-core/` 模块，与业务服务**同进程、同 Pod** 部署
- 模块化组织，便于后续独立拆分
- 业务服务通过**进程内函数调用**使用 AI-Agent 能力（TypeScript import），不经过网络

**后续演进**（P1/P2）：
- 当 AI 调用量增长或需要独立扩缩容时，可将 `ai-core/` 拆分为独立微服务
- 拆分后业务服务通过 HTTP/gRPC 调用，接口契约保持不变（附录 B 的 DTO 即拆分的契约基础）

**目录结构（规划）**：

```text
apps/server/
├── src/
│   ├── ai-core/                       # AI-Agent 中枢模块
│   │   ├── infra/                     # 基础设施层
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
│   │   │   └── fallback-handler.ts
│   │   ├── capabilities/             # 能力层
│   │   │   ├── tutoring.capability.ts
│   │   │   ├── grading.capability.ts
│   │   │   ├── explanation.capability.ts
│   │   │   ├── variation.capability.ts
│   │   │   └── analytics.capability.ts
│   │   ├── prompts/                   # Prompt 模板文件
│   │   │   ├── system/
│   │   │   ├── tutoring/
│   │   │   │   ├── math/
│   │   │   │   ├── chinese/
│   │   │   │   └── english/
│   │   │   ├── grading/
│   │   │   ├── variation/
│   │   │   └── safety/
│   │   ├── types.ts                   # DTO 类型定义
│   │   └── config.yaml                # 模型路由与安全配置
│   ├── services/                      # 业务服务
│   │   ├── content/
│   │   ├── assessment/
│   │   ├── conversation/
│   │   ├── parent-admin/
│   │   ├── auth/
│   │   └── reward/
│   └── ...
└── package.json
```

---

接下来是第 3 章（基础设施层）的开始标记，详见下一部分。

---

## 3. 基础设施层（infra）

基础设施层提供共用、薄、无业务状态的基础能力，所有 capabilities 通过调用 infra 层组件来编排 AI 行为。

### 3.1 ModelRouter — 多模型路由

#### 3.1.1 职责

根据请求的**场景（scene）**、**学科（subject）**、**难度（difficulty）**等维度，从可配置的路由表中选择最优的 LLM 模型及备选模型。路由决策对调用方透明。

#### 3.1.2 接口定义

```typescript
interface RouteRequest {
  /** 业务场景 */
  scene: 'tutoring' | 'grading' | 'judgment' | 'explanation' | 'variation' | 'analysis' | 'safety' | 'structuring' | 'hint' | 'title';
  /** 学科 */
  subject: 'math' | 'chinese' | 'english';
  /** 难度等级 1=易 2=中 3=难 */
  difficulty?: 1 | 2 | 3;
  /** 预估输入 token 数 */
  estimatedInputTokens?: number;
  /** 是否需要强推理能力（长推理链、多步证明） */
  requiresHeavyReasoning?: boolean;
}

interface RouteResult {
  /** 首选模型配置 */
  primary: ModelConfig;
  /** 备选模型配置（primary 失败时使用） */
  fallback?: ModelConfig;
  /** 路由决策依据（用于日志/调试） */
  reason: string;
}

interface ModelConfig {
  /** 模型标识（如 'qwen3.8-max'） */
  modelId: string;
  /** 厂商 */
  provider: 'kimi' | 'qwen' | 'gemini' | 'deepseek';
  /** API 端点 */
  baseUrl: string;
  /** 上下文窗口上限（token） */
  contextWindow: number;
  /** 单次最大输出 token */
  maxOutputTokens: number;
  /** 每 1K token 成本（输入/输出，用于成本估算） */
  costPer1K: { input: number; output: number };
  /** 是否支持流式 */
  supportsStreaming: boolean;
}
```

#### 3.1.3 路由策略表

以下是完整的场景-学科-模型映射，路由决策严格遵循此表。底层由 YAML 配置文件驱动（见附录 C），运行时可热加载。

**辅导场景（tutoring）**：

| 学科 | 难度 | 首选模型 | 备选模型 | 说明 |
|------|------|----------|----------|------|
| math | 1-2（易/中） | Qwen-3.8-Max | DeepSeek-V4-Flash | 中文数学推理强、响应快 |
| math | 3（难） | Gemini-3.1-Pro | Qwen-3.8-Max | 长推理链、多步证明 |
| chinese | 任意 | Kimi | DeepSeek-V4-Flash | 中文表达自然，文学素养好 |
| english | 任意 | Kimi | Qwen-3.8-Max | 双语能力强 |

**批改场景（grading）**：

| 学科 | 首选模型 | 备选模型 | 说明 |
|------|----------|----------|------|
| math | Qwen-3.8-Max | Kimi | 数学逻辑强，按步骤判分准确 |
| chinese | Kimi | Qwen-3.8-Max | 语文阅读理解、作文批改需语义理解 |
| english | Kimi | Qwen-3.8-Max | 英语写作批改 |

**解析/重讲（explanation）**：

| 学科 | 首选模型 | 备选模型 |
|------|----------|----------|
| math | Qwen-3.8-Max | DeepSeek-V4-Flash |
| chinese | Kimi | Qwen-3.8-Max |
| english | Kimi | Qwen-3.8-Max |

**变式题生成（variation）**：

| 学科 | 首选模型 | 备选模型 | 说明 |
|------|----------|----------|------|
| math | Qwen-3.8-Max | Gemini-3.1-Pro | 需结构化输出，数学严谨性高 |

**学情分析（analysis）**：

| 学科 | 首选模型 | 备选模型 | 说明 |
|------|----------|----------|------|
| 任意 | Kimi | Qwen-3.8-Max | 中文总结自然，报告可读性好 |

**安全检测（safety）**：

| 场景 | 首选模型 | 备选模型 |
|------|----------|----------|
| 任意 | DeepSeek-V4-Flash | — |

#### 3.1.4 路由决策流程

```text
route(request) → RouteResult
  
  1. 查路由表：用 (scene, subject, difficulty) 做 key
     ├─ 精确匹配 → 返回对应条目
     └─ 无精确匹配 → 降级匹配（去掉 difficulty → 用通配 subject → 用默认）
  
  2. 动态调整（可选，P1 阶段）：
     ├─ 检查模型健康状态（连续失败次数）
     ├─ 检查当前配额余量（低成本模型优先）
     └─ 检查模型延迟（超时模型暂时降权）
```

#### 3.1.5 核心处理逻辑（伪代码）

```typescript
class ModelRouter {
  private routeTable: RouteRule[];
  
  async route(request: RouteRequest): Promise<RouteResult> {
    // 1. 查配置表
    const rule = this.matchRule(request.scene, request.subject, request.difficulty);
    
    // 2. 检查首选模型健康状态
    if (this.isCircuitBroken(rule.primary)) {
      if (rule.fallback) {
        return {
          primary: rule.fallback,
          fallback: undefined,
          reason: `主模型 ${rule.primary} 已熔断，使用备选 ${rule.fallback}`
        };
      }
    }
    
    // 3. 返回路由结果
    return {
      primary: rule.primary,
      fallback: rule.fallback,
      reason: `场景=${request.scene} 学科=${request.subject} 难度=${request.difficulty}`
    };
  }
  
  private matchRule(scene, subject, difficulty): RouteRule {
    // 1. 精确匹配: scene + subject + difficulty
    // 2. 忽略 difficulty 匹配: scene + subject
    // 3. 场景通配: scene + any subject
    // 4. 默认规则
  }
  
  // P1 实现：熔断器
  private isCircuitBroken(modelId: string): boolean {
    const failures = this.failureCounter.get(modelId);
    return failures >= this.config.circuitBreakThreshold; // 默认 5 次/分钟
  }
}
```

---

### 3.2 PromptBuilder — 提示词模板与构建

#### 3.2.1 职责

根据场景、学科、上下文变量，从模板文件系统中加载对应 Prompt 模板，注入变量后构建完整的 `ChatMessage[]`。不负责模型调用，仅输出构建好的消息数组。

#### 3.2.2 模板文件组织

```text
prompts/
├── system/
│   ├── base.md                    # 通用系统提示（角色设定、基本规则）
│   ├── socratic-rules.md          # 苏格拉底通用规则（所有 tutoring 模板的公共片段）
│   └── safety-rules.md            # 安全边界规则（所有模板引用）
├── tutoring/
│   ├── math/
│   │   ├── mainline.md            # 数学主线辅导（限定卡片范围）
│   │   └── auxiliary.md           # 数学辅线辅导（开放范围）
│   ├── chinese/
│   │   ├── mainline.md
│   │   └── auxiliary.md
│   └── english/
│       ├── mainline.md
│       └── auxiliary.md
├── grading/
│   ├── math-proof.md              # 数学证明题批改
│   ├── math-calculation.md        # 数学计算题批改
│   ├── chinese-reading.md         # 语文阅读理解批改
│   └── essay.md                   # 通用作文批改（语文/英语）
├── explanation/
│   ├── error-analysis.md          # 错题解析
│   ├── knowledge-retry.md         # 知识点重讲
│   └── solution.md                # 标准题解（可入库复用）
├── variation/
│   ├── math-generate.md           # 数学变式题生成
│   └── math-validate.md           # 变式题校验（P1 实现）
├── safety/
│   ├── classifier.md              # 内容分类器
│   └── gentle-block.md            # 温和阻断话术
├── fallback/
│   └── full-explanation.md        # 兜底完整解析
└── analytics/
    └── report.md                  # 学情报告生成
```

#### 3.2.3 接口定义

```typescript
interface PromptBuildRequest {
  /** 能力类型（决定模板目录） */
  capability: 'tutoring' | 'grading' | 'explanation' | 'variation' | 'analysis';
  /** 学科 */
  subject: string;
  /** 学习轨道（仅 tutoring 场景需要） */
  track?: 'mainline' | 'auxiliary';
  /** 题型（仅 grading 场景需要） */
  questionType?: 'proof' | 'calculation' | 'reading' | 'essay';
  /** 模板变量上下文 */
  context: PromptContext;
}

interface PromptContext {
  /** 学生信息 */
  student: {
    grade: string;        // 年级，如 'grade7'
    gradeLevel: string;   // 学段，如 'junior'
  };
  /** 教材卡片内容（主线 tutoing 必传） */
  cardContent?: string;
  /** 当前知识点 */
  knowledgePoint?: {
    id: string;
    name: string;
    description?: string;
  };
  /** 题目信息（grading/variation/explanation 场景） */
  question?: {
    content: string;
    answer?: string;
    difficulty?: 1 | 2 | 3;
    rubric?: string;
  };
  /** 学生作答（grading 场景） */
  studentAnswer?: string;
  /** 对话历史（tutoring 场景，由 ConversationService 提供） */
  dialogueHistory?: Message[];
  /** 用户当前消息 */
  userMessage: string;
  /** 自定义变量覆盖 */
  customVariables?: Record<string, string>;
}

interface PromptBuildResult {
  /** 构建好的消息数组 */
  messages: ChatMessage[];
  /** 预估 token 消耗 */
  estimatedTokens: number;
  /** 使用的模板版本 */
  templateVersion: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
```

#### 3.2.4 模板变量规范

所有模板文件使用 Mustache 风格 `{{variableName}}` 语法。支持的变量由 `PromptContext` 提供。

**条件渲染**：以 `{{#variableName}}...{{/variableName}}` 标记可选段（变量存在且非空时渲染）。

**模板示例结构**（具体内容见第 5 章和附录 A）：

```markdown
## System Prompt

你是一位{{roleDescription}}，专门帮助{{student.gradeLevel}}的学生学习{{subjectName}}。

{{> socratic-rules}}  <!-- 引用公共片段 -->

<card_content>
{{cardContent}}
</card_content>

{{#knowledgePoint}}
当前知识点：{{knowledgePoint.name}}
{{/knowledgePoint}}

## User Message

{{> dialogue-history}}  <!-- 渲染对话历史 -->

学生当前问题：
{{userMessage}}
```

#### 3.2.5 核心处理逻辑（伪代码）

```typescript
class PromptBuilder {
  private templateCache: Map<string, string> = new Map();
  private templateBasePath: string;
  
  async build(request: PromptBuildRequest): Promise<PromptBuildResult> {
    // 1. 计算模板路径
    const templatePath = this.resolveTemplatePath(request);
    
    // 2. 加载模板（带缓存）
    const template = await this.loadTemplate(templatePath);
    
    // 3. 加载公共片段并合并
    const partials = await this.loadPartials(['socratic-rules', 'safety-rules']);
    const merged = this.mergePartials(template, partials);
    
    // 4. 注入变量
    const rendered = this.render(merged, request.context);
    
    // 5. 构建消息数组
    const messages: ChatMessage[] = [
      { role: 'system', content: this.extractSystemPrompt(rendered) },
      { role: 'user', content: this.extractUserMessage(rendered) },
    ];
    
    // 6. 如有多轮历史，追加 assistant/user 对
    if (request.context.dialogueHistory) {
      messages.push(...request.context.dialogueHistory);
    }
    
    // 7. 估算 token
    const estimatedTokens = await this.estimateTokens(messages);
    
    return { messages, estimatedTokens, templateVersion: this.getVersion(templatePath) };
  }
}
```

---

### 3.3 ModelClient — 多厂商客户端适配

#### 3.3.1 职责

封装多厂商 LLM API 调用，提供统一的 `chat()` 和 `streamChat()` 接口。屏蔽各厂商的 API 差异（鉴权方式、请求格式、响应格式），对上层透明。

#### 3.3.2 支持的厂商

| 厂商 | 模型 | API 协议 | 流式支持 |
|------|------|----------|----------|
| Kimi（月之暗面） | kimi-latest | OpenAI 兼容 | ✅ SSE |
| Qwen（通义千问） | qwen3.8-max | OpenAI 兼容 | ✅ SSE |
| Gemini（Google） | gemini-3.1-pro | Gemini API | ✅ SSE |
| DeepSeek | deepseek-flash | OpenAI 兼容 | ✅ SSE |

#### 3.3.3 接口定义

```typescript
interface ChatRequest {
  model: ModelConfig;
  messages: ChatMessage[];
  temperature?: number;           // 默认 0.7
  maxTokens?: number;             // 默认取 model.maxOutputTokens
  stopSequences?: string[];
  responseFormat?: 'text' | 'json_object';
  timeout?: number;               // 默认 30s
}

interface ChatResponse {
  id: string;
  model: string;
  content: string;
  reasoningContent?: string;       // thinking 内容(reasoner 模型 reasoning_content 聚合),透传前端展示
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
  usage: {
    inputTokens: number;
    outputTokens: number;
    cost: number;                 // 本次调用费用（按 model.costPer1K 计算）
  };
  latencyMs: number;
}

interface StreamChunk {
  content: string;                // 增量 delta 文本(回答)
  reasoningContent?: string;      // 增量 thinking delta(reasoning_content)
  finishReason?: 'stop' | 'length' | 'content_filter' | 'error';
}
```

#### 3.3.4 错误体系（基于 ../llm-client.js）

```typescript
interface ErrorContext {
  provider: string;
  statusCode: number;             // 0 表示无响应(网络/超时)
  providerCode: string | null;    // provider 特定错误码
  retryable: boolean;
  retryAfterMs: number | null;    // 解析自 Retry-After header
  hint: string;                   // 人类可读的修复提示
  modelId: string;
}

// 抽象基类,所有 LLM 客户端错误的父类
class LLMClientError extends Error {
  provider: string;
  statusCode: number;
  providerCode: string | null;
  retryable: boolean;
  retryAfterMs: number | null;
  hint: string;
  modelId: string;
}

// 11 个子类(按 HTTP status 分类,retryable 由子类决定):
class AuthenticationError extends LLMClientError;      // 401,不可重试
class InsufficientQuotaError extends LLMClientError;   // 402 / 429-insufficient_quota / qwen arrearage,不可重试
class PermissionError extends LLMClientError;          // 403,不可重试
class ResourceNotFoundError extends LLMClientError;    // 404,不可重试
class RequestTooLargeError extends LLMClientError;     // 413,不可重试(原 CONTEXT_TOO_LONG)
class ValidationFailedError extends LLMClientError;   // 400/422,不可重试
class ContentFilteredError extends LLMClientError;     // 406 / gemini SAFETY,不可重试(ai-core 扩展,llm-client 无此类)
class RateLimitError extends LLMClientError;           // 429 限流,可重试
class ServerError extends LLMClientError;              // 5xx,可重试
class TimeoutError extends LLMClientError;             // abort/网络/408,可重试

// 分类器: (provider, status, body, headers, modelId) -> 对应错误子类
function classifyError({ provider, status, body, headers, modelId }): LLMClientError;
```

#### 3.3.5 重试策略（callWithRetry, full-jitter 退避）

```typescript
interface RetryOptions {
  maxRetries: number;             // 默认 2(retry.yaml)
  baseDelayMs: number;            // 默认 1000
  maxBackoffMs: number;           // 默认 60000
  onRetry?: (err: LLMClientError | Error, attempt: number, delayMs: number) => void;
}

// full-jitter 指数退避: delay = random(0, min(maxBackoff, base * 2^attempt))
function jitteredBackoff(attempt: number, baseDelay: number, maxBackoff: number): number;

// 解析 Retry-After header(整数秒 / HTTP-date),返回毫秒
function parseRetryAfter(value: string | null): number | null;

// 包装异步操作,带 full-jitter 退避:
//   - 非 retryable LLMClientError -> 立即抛
//   - 重试耗尽 -> 抛最后一个错误
//   - retryAfterMs 存在 -> 遵守(capped at maxBackoffMs)
//   - 否则 -> jitteredBackoff(attempt)
//   - 非 LLMClientError(原始网络/abort)视为可重试
async function callWithRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T>;
```

#### 3.3.6 核心处理逻辑（伪代码）

```typescript
class ModelClient {
  private providers: Map<string, ProviderAdapter>;
  private retryOptions: RetryOptions;

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const provider = this.getProvider(request.model.provider);
    const startTime = Date.now();
    // 默认流式; gemini 暂降级非流式(streamGenerateContent 待实现)
    const useStream = request.stream !== false && request.model.provider !== 'gemini';

    const run = async (): Promise<ChatResponse> => {
      if (useStream) {
        return this.aggregateStream(provider, request, startTime);  // 消费 streamChat 聚合
      }
      const response = await provider.chat(request);
      return { ...response, latencyMs: Date.now() - startTime };
    };

    return callWithRetry(run, this.retryOptions);  // full-jitter 重试
  }

  // 流式聚合: for await 消费 streamChat,累加 content + reasoningContent
  private async aggregateStream(provider, request, startTime): Promise<ChatResponse> {
    let content = '', reasoningContent = '', finishReason = 'stop';
    for await (const chunk of provider.streamChat(request)) {
      if (chunk.reasoningContent) reasoningContent += chunk.reasoningContent;
      if (chunk.content) content += chunk.content;
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    return { id, model, content, reasoningContent: reasoningContent || undefined, finishReason, usage: {0,0,0}, latencyMs };
  }

  // 真流式(供 HTTP 层 SSE 转发),不套 callWithRetry(mid-stream 重试会重复 token)
  streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    return this.getProvider(request.model.provider).streamChat(request);
  }
}
```

**流式与 thinking(reasoning_content)约定**：
- `chat()` 默认 `stream: true`，走流式聚合；`stream: false` 降级非流式(用于 gemini 或显式降级)
- 流式响应中 `delta.reasoning_content`(thinking)与 `delta.content`(回答)分开读取，分别聚合到 `ChatResponse.reasoningContent` 与 `ChatResponse.content`
- `reasoningContent` 透传到各 capability 响应(TutoringResponse/GradingResult/ExplanationResponse/VariationResponse/AnalyticsResponse/FallbackResponse 的 `reasoning` 字段)，供前端展示思考过程；**前端如何显示是前端的事，但 Agent 必须捕获并透传**
- gemini 流式(streamGenerateContent)暂未实现(待配 GEMINI_API_KEY)，ModelClient 对 gemini 强制非流式降级
- `streamChat()` 不套 `callWithRetry`--mid-stream 重试会重复生成 token，流错误由调用方(HTTP 层)处理
- `streamChat()` 用**空闲超时**（`streaming.firstTokenTimeoutMs`/`interTokenTimeoutMs`，每收到数据即重置，见 C.2），空闲触发抛 `TimeoutError`(408)；用户主动停止（外部 `AbortSignal`）抛 `AbortError`，不当作失败
- 流式**中途失败/超时**已产出部分时，capability 会 best-effort 落库已聚合的 `reasoning`/`content`（assistant content 为空时填 `[生成中断]`）连同用户消息，刷新后仍可回看；若尚无任何产出则只落用户消息（刷新回到「末条 user 待重试」）
- 流式 usage 尽力收(部分 provider 如 Kimi 流式不返回 usage，此时 cost=0)
- 流式响应首个 chunk 应包含 `role: 'assistant'`，供 ConversationService 预分配消息记录
- 流式传输中断时，已接收的内容持久化不丢失，客户端重连后从 `lastMessageId` 续传

---

### 3.4 SafetyGuard — 安全边界检测

#### 3.4.1 职责

对所有用户输入进行前置安全检查，判定其是否为学习相关内容、是否包含异常行为，并输出预警级别和阻断决策。

#### 3.4.2 三层检测模型

```text
用户输入
  │
  ▼
第 1 层：学习相关性分类
  ├─ learning → 放行，进入正常辅导流程
  ├─ off_topic → 进入第 2 层
  └─ anomaly → 进入第 3 层
  │
  ▼
第 2 层：闲聊处置（off_topic）
  └─ 返回温和阻断话术 + 写 info 级预警
  │
  ▼
第 3 层：异常处置（anomaly）
  ├─ 情绪发泄 → 温和话术 + 写 warning 级预警
  └─ 敏感/违规 → 阻断 + 写 critical 级预警
```

#### 3.4.3 接口定义

```typescript
interface SafetyCheckRequest {
  studentId: string;
  message: string;
  dialogueHistory: Message[];     // 最近 5 条，用于判断连续模式
  track: 'mainline' | 'auxiliary';
}

interface SafetyCheckResult {
  /** 是否为学习相关内容 */
  isLearningRelated: boolean;
  /** 分类 */
  classification: 'learning' | 'off_topic' | 'anomaly';
  /** 异常子类型（仅 anomaly 时有值） */
  anomalyType?: 'emotional' | 'sensitive' | 'abusive';
  /** 预警级别 */
  alertLevel: 'none' | 'info' | 'warning' | 'critical';
  /** 是否需要阻断 */
  shouldBlock: boolean;
  /** 阻断时返回的话术 */
  blockResponse?: string;
  /** 预警记录（非 none 时必填） */
  alertPayload?: SafetyAlert;
}

interface SafetyAlert {
  studentId: string;
  level: 'info' | 'warning' | 'critical';
  type: 'off_topic' | 'emotional' | 'sensitive' | 'abusive';
  message: string;
  timestamp: Date;
}
```

#### 3.4.4 连续闲聊升级策略

单次闲聊（off_topic）触发 info 级预警（不推家长端，仅记录）。在同一对话中连续 3 次闲聊则升级为 warning 级（推家长端 Banner 提醒）：

| 连续闲聊次数 | 预警级别 | 家长端行为 |
|-------------|----------|-----------|
| 1 | info | 仅记录，不推送 |
| 2 | info | 仅记录，不推送 |
| 3+ | warning | 推送 Banner 预警 |
| 5+ | critical | 推送 Banner + 强制暂停 AI 对话 |

#### 3.4.5 温和阻断话术库

详见 §5.5 和附录 A.14。

**话术选择规则**：
- `off_topic`：从闲聊话术库随机选择（避免重复感）
- `emotional`：从情绪安抚话术库选择，优先安抚再引导
- `sensitive`：固定话术，不安抚、直接引导回学习 + 写 critical 预警

#### 3.4.6 核心处理逻辑（伪代码）

```typescript
class SafetyGuard {
  async check(request: SafetyCheckRequest): Promise<SafetyCheckResult> {
    // 1. 调用分类模型（DeepSeek-V4-Flash）
    const classification = await this.classify(request.message);
    
    // 2. 如果是学习内容，直接放行
    if (classification === 'learning') {
      return { isLearningRelated: true, classification, alertLevel: 'none', shouldBlock: false };
    }
    
    // 3. 闲聊处理
    if (classification === 'off_topic') {
      const consecutiveCount = this.countConsecutiveOffTopic(request.dialogueHistory);
      const alertLevel = consecutiveCount >= 5 ? 'critical' : consecutiveCount >= 3 ? 'warning' : 'info';
      return {
        isLearningRelated: false,
        classification,
        alertLevel,
        shouldBlock: true,
        blockResponse: this.pickGentleBlockMessage('off_topic'),
        alertPayload: alertLevel !== 'info' ? this.buildAlert(request, alertLevel, 'off_topic') : undefined,
      };
    }
    
    // 4. 异常处理
    const anomalyType = await this.detectAnomalyType(request.message);
    return {
      isLearningRelated: false,
      classification: 'anomaly',
      anomalyType,
      alertLevel: anomalyType === 'sensitive' || anomalyType === 'abusive' ? 'critical' : 'warning',
      shouldBlock: true,
      blockResponse: this.pickGentleBlockMessage(anomalyType),
      alertPayload: this.buildAlert(request, anomalyType === 'sensitive' ? 'critical' : 'warning', anomalyType),
    };
  }
}
```

---

### 3.5 ResponseParser — 结构化输出解析

#### 3.5.1 职责

将 LLM 返回的原始文本解析为结构化的业务对象。支持 LaTeX 数学公式规范化、JSON 提取与校验、Markdown 格式化。

#### 3.5.2 支持的解析模式

| 模式 | 输入 | 输出 | 使用场景 |
|------|------|------|----------|
| `text` | 纯文本/Markdown | 字符串 | Tutoring（对话文本） |
| `latex` | 含 LaTeX 的文本 | 规范化 LaTeX 字符串 | 数学解题过程 |
| `json` | JSON 字符串 | 校验后的 TypeScript 对象 | Grading（评分结果）、Variation（变式题）、Safety（分类结果） |
| `hybrid` | Markdown + LaTeX + JSON | 结构化对象 | 学情报告 |

#### 3.5.3 接口定义

```typescript
type ParseMode = 'text' | 'latex' | 'json' | 'hybrid';

interface ParseRequest {
  rawContent: string;
  mode: ParseMode;
  schema?: object;                 // json 模式下的 Zod/JSON Schema，用于校验
  defaultResult?: unknown;         // 解析失败时的默认返回值
}

interface ParseResult<T = unknown> {
  success: boolean;
  data: T | null;                  // 解析成功的结构化数据
  rawText?: string;                // text 模式下的纯文本
  errors?: string[];               // 校验失败的错误列表
}
```

#### 3.5.4 核心批改结果结构

```typescript
interface GradingResult {
  totalScore: number;
  maxScore: number;
  steps: StepGrade[];
  feedback: string;
  suggestions: string[];
}

interface StepGrade {
  stepNumber: number;
  description: string;
  score: number;
  maxScore: number;
  isCorrect: boolean;
  comment: string;
  errorType?: 'logic' | 'calculation' | 'format' | 'missing';
}
```

#### 3.5.5 JSON 解析容错策略

LLM 返回的 JSON 可能存在格式问题，采用逐级容错：

1. **直接解析**：`JSON.parse()` → 成功则返回
2. **提取 + 解析**：用正则提取 ``````json ... ``` 包裹的代码块 → 再 parse
3. **修复 + 解析**：修复常见问题——尾部逗号、未闭合引号、单引号替换 → 再 parse
4. **Schema 校验**：解析成功后用 Zod Schema 校验 → 不通过则填入 defaultResult
5. **兜底**：所有尝试失败 → 返回 `{ success: false, data: defaultResult, errors: [...] }`

#### 3.5.6 核心处理逻辑（伪代码）

```typescript
class ResponseParser {
  parse<T>(request: ParseRequest): ParseResult<T> {
    switch (request.mode) {
      case 'text':
        return { success: true, data: null, rawText: request.rawContent };
      case 'latex':
        return { success: true, data: this.normalizeLatex(request.rawContent) as T };
      case 'json':
        return this.parseJson<T>(request.rawContent, request.schema);
      case 'hybrid':
        return this.parseHybrid<T>(request.rawContent, request.schema);
    }
  }
  
  private parseJson<T>(raw: string, schema?: object): ParseResult<T> {
    let data: unknown;
    
    // 1. 直接解析
    try { data = JSON.parse(raw); } catch { /* 继续 */ }
    
    // 2. 提取代码块
    if (!data) {
      const match = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      if (match) try { data = JSON.parse(match[1]); } catch { /* 继续 */ }
    }
    
    // 3. 修复常见错误
    if (!data) {
      const repaired = this.repairJson(raw);
      try { data = JSON.parse(repaired); } catch { /* 继续 */ }
    }
    
    // 4. Schema 校验
    if (data && schema) {
      const result = this.validateSchema(data, schema);
      if (!result.success) {
        return { success: false, data: request.defaultResult as T, errors: result.errors };
      }
    }
    
    if (data) {
      return { success: true, data: data as T };
    }
    
    return { success: false, data: null, errors: ['All JSON parsing attempts failed'] };
  }
  
  private normalizeLatex(text: string): string {
    // 统一行内公式为 $...$
    // 统一块级公式为 $$...$$
    // 转义 Markdown 冲突字符
    return text; // 简化示例
  }
}
```

---

### 3.6 FallbackHandler — 连续失败兜底

#### 3.6.1 职责

当学生在同一知识点上连续 3 次回答错误或表示"不会/放弃"时，触发兜底机制：停止苏格拉底式提问，输出完整解析步骤与知识点总结。

#### 3.6.2 触发条件

1. **连续失败**：同一知识点连续 3 次回答错误
2. **明确放弃**：学生消息匹配"不会""不懂""不知道""太难了""放弃"等关键词
3. **兜底后恢复**：兜底完成后重置失败计数，学生继续下一知识点

**注意**：失败计数按**知识点**维度，而非对话维度。切换到新知识点时重置计数。

#### 3.6.2.1 辅线答疑「明确索要详细解析」走题库（2026-09-11 新增）

辅线答疑场景（`mode='auxiliary'`）多一条**不经过 FallbackHandler / 不调用模型**的快路径，实现在 `AIService.maybeStoredExplanation`：学生已与 AI 来回 ≥ `fallback.yaml.fallback.detailedExplanationAfterRounds`（默认 2）轮、且当前消息命中 `detailedExplanationKeywords` 时，直接从题库取该题的 **答案 + 解题思路 + 解析**（`questions.answer/approach/explanation`）返回。

- 题目定位：会话 `ai_dialogues.question_id`（AI 首次结构化入库时回填）优先；老会话无锚点则用首条用户消息的题干匹配——`content_hash` 优先、**「归一化去标点后的前 20 个字」兜底**（同一题文字/格式微调也能命中），多命中取最新。
- **命中** -> 直接输出题库内容（不调模型）；**查不到题或题库无可用内容** -> `TutoringRequest.forceFallback=true` 强制走 `FallbackHandler` 的 **AI 完整解析**，**不再回到苏格拉底式追问**。
- 结构化题目输出新增 `approach`（解题思路）字段，与 answer/explanation 一起入库，供该快路径复用；入库时按 hash / 前 20 字去重（不重复插入），并确保该学生错题本有这道题（`source='auxiliary'`）。详见 PRD §7.9/§7.10、辅线设计 §8.1.1。

#### 3.6.3 接口定义

```typescript
interface FallbackRequest {
  studentId: string;
  dialogueId: string;
  knowledgePoint: KnowledgePoint;
  question?: QuestionContext;
  dialogueHistory: Message[];       // 当前对话历史
  track: 'mainline' | 'auxiliary';
}

interface FallbackResponse {
  type: 'fallback';
  content: string;                  // 完整解析文本（Markdown + LaTeX）
  includesCompleteAnswer: true;     // 明确标记已输出完整答案（供前端区分展示）
  summary: string;                  // 知识点总结
  recommendations: string[];        // 学习建议
}
```

#### 3.6.4 输出结构

兜底响应按以下结构组织：

```text
1. 温和开场（不责备）：
   "这个知识点确实有难度，我们一起来看看完整的解题思路。"

2. 完整解题步骤：
   步骤 1：...（解释为什么这么做）
   步骤 2：...（解释每一步的逻辑）
   步骤 n：得出答案

3. 知识点总结：
   - 核心公式 / 概念
   - 适用条件
   - 常见误区

4. 学习建议：
   - 建议 1（如：先复习 XX 前置知识）
   - 建议 2（如：用更简单的题目练习）
```

#### 3.6.5 核心处理逻辑（伪代码）

```typescript
class FallbackHandler {
  async handle(request: FallbackRequest): Promise<FallbackResponse> {
    // 1. 构建兜底 Prompt
    const promptResult = await this.promptBuilder.build({
      capability: 'explanation',
      subject: request.knowledgePoint.subject,
      context: {
        student: request.student,
        knowledgePoint: request.knowledgePoint,
        question: request.question,
        dialogueHistory: request.dialogueHistory,
        userMessage: '我需要完整的解析',
      },
    });
    
    // 2. 调用模型（用低价模型即可）
    const routeResult = await this.modelRouter.route({
      scene: 'explanation',
      subject: request.knowledgePoint.subject,
    });
    
    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
    });
    
    // 3. 解析为结构化兜底响应
    return {
      type: 'fallback',
      content: chatResponse.content,
      includesCompleteAnswer: true,
      summary: this.extractSummary(chatResponse.content),
      recommendations: this.extractRecommendations(chatResponse.content),
    };
  }
}
```

---

接下来是第 4 章（能力层）的开始标记。

---

## 4. 能力层（capabilities）

能力层是 AI-Agent 中枢的业务编排层，调用 infra 层组件组合实现具体的智能能力。每个 capability 对应一个独立的业务场景入口。

### 4.1 TutoringCapability — 苏格拉底辅导

#### 4.1.1 职责

处理学生的 AI 辅导请求（主线"讨论"和辅线"答疑"），执行苏格拉底式引导——不直接给答案，通过提问一步步引导学生思考。是 AI-Agent 中枢**最高频的核心能力**。

#### 4.1.2 主线 vs 辅线差异

| 维度 | 主线"讨论" | 辅线辅导 |
|------|-----------|----------|
| 触发入口 | 教材卡片页"讨论"按钮 | 探索首页 / 知识点选择 / 拍照上传 |
| 知识范围 | **严格限定**当前卡片内容 | **不受限**，可跨知识点 |
| 卡片原文 | **必传**（`cardId`） | 可选 |
| 是否生成错题 | **否**（讨论不计错题） | **是**（题目自动入主线错题本，source=auxiliary 不参与门禁，PRD §7.4） |
| 上下文长度 | 较短（单卡片知识点集中） | 较长（可能跨多个知识点） |
| Prompt 模板 | `tutoring/{subject}/mainline.md` | `tutoring/{subject}/auxiliary.md` |

#### 4.1.3 辅导状态机

```text
                   ┌───────────────────────────────────┐
                   │                                   │
                   ▼                                   │
    ┌──────┐  用户提问   ┌──────────┐               ┌──┴───┐
    │ IDLE │ ─────────► │  SAFETY  │               │BLOCKED│
    └──────┘            │  CHECK   │               │ (阻断) │
                        └────┬─────┘               └───────┘
                             │
              ┌──────────────┼──────────────────┐
              ▼              ▼                  ▼
        ┌──────────┐   ┌──────────┐      ┌──────────┐
        │ TUTORING │   │  ALERT   │      │ BLOCKED  │
        │ (辅导中)  │   │ (预警记录)│      │ (阻断+话术)│
        └────┬─────┘   └──────────┘      └──────────┘
             │
    ┌────────┼────────┐
    ▼        ▼        ▼
┌────────┐ ┌────────┐ ┌────────┐
│CONTINUE│ │FALLBACK│ │COMPLETE│
│(继续引导│ │(兜底)  │ │(完成)  │
└────────┘ └────────┘ └────────┘
```

**状态说明**：

| 状态 | 说明 | 触发条件 |
|------|------|----------|
| IDLE | 等待用户输入 | 对话开始 / 上一轮回复完成 |
| SAFETY_CHECK | 安全检查中 | 收到用户消息后立即进入 |
| TUTORING | 苏格拉底引导中 | SafetyGuard 判定为 `learning` |
| ALERT | 异常预警 | SafetyGuard 判定为 `off_topic` 或 `anomaly`（不阻断场景） |
| BLOCKED | 阻断 | SafetyGuard 判定需要阻断（连续闲聊/敏感内容） |
| CONTINUE | 继续下一轮 | 学生正确回答了引导问题 |
| FALLBACK | 触发兜底 | 同一知识点连续 3 次失败或学生明确放弃 |
| COMPLETE | 对话结束 | 学生理解了知识点 / 主动结束 / 超时 |

#### 4.1.4 接口定义

```typescript
interface TutoringRequest {
  studentId: string;
  mode: 'mainline' | 'auxiliary';
  /** 主线模式必传 */
  cardId?: string;
  /** 辅线模式可选 */
  knowledgeId?: string;
  /** 用户消息 */
  message: string;
  /** 附件（图片/公式） */
  attachments?: Attachment[];
  /** 多轮对话 ID */
  dialogueId?: string;
}

interface TutoringResponse {
  dialogueId: string;
  message: {
    role: 'assistant';
    content: string;
    /** 消息类型 */
    type: 'socratic' | 'fallback' | 'block' | 'complete';
  };
  /** 安全检查结果 */
  safety: {
    isLearningRelated: boolean;
    alertLevel: 'none' | 'info' | 'warning' | 'critical';
  };
  /** 是否触发兜底 */
  isFallback: boolean;
  /** 当前失败计数（供前端展示参考） */
  consecutiveFailCount: number;
}
```

#### 4.1.5 完整处理流程

```typescript
class TutoringCapability {
  async tutor(request: TutoringRequest): Promise<TutoringResponse> {
    // ──── 第 1 步：安全检查 ────
    const safetyResult = await this.safetyGuard.check({
      studentId: request.studentId,
      message: request.message,
      dialogueHistory: await this.loadRecentHistory(request.dialogueId),
      track: request.mode,
    });

    if (safetyResult.shouldBlock) {
      // 写阻断消息到对话
      await this.saveMessage(request.dialogueId, {
        role: 'assistant',
        content: safetyResult.blockResponse!,
        type: 'block',
      });
      // 写预警
      if (safetyResult.alertPayload) {
        await this.writeAlert(safetyResult.alertPayload);
      }
      return {
        dialogueId: request.dialogueId!,
        message: { role: 'assistant', content: safetyResult.blockResponse!, type: 'block' },
        safety: { isLearningRelated: false, alertLevel: safetyResult.alertLevel },
      };
    }

    // ──── 第 2 步：加载上下文 ────
    const context = await this.conversationService.loadContext(request.dialogueId, {
      tokenBudget: 3000, // 预留 3000 token 给上下文，其余给新的生成
    });

    // ──── 第 3 步：检查兜底条件 ────
    if (context.consecutiveFailCount >= 3 || this.isGiveUpMessage(request.message)) {
      return await this.fallbackHandler.handle({
        studentId: request.studentId,
        dialogueId: request.dialogueId!,
        knowledgePoint: context.currentKnowledgePoint,
        question: context.currentQuestion,
        dialogueHistory: context.messages,
        track: request.mode,
      });
    }

    // ──── 第 4 步：路由模型 ────
    const routeResult = await this.modelRouter.route({
      scene: 'tutoring',
      subject: context.subject,
      difficulty: context.currentDifficulty,
    });

    // ──── 第 5 步：构建 Prompt ────
    const promptHash = await this.promptBuilder.build({
      capability: 'tutoring',
      subject: context.subject,
      track: request.mode,
      context: {
        student: context.student,
        cardContent: context.cardContent,
        knowledgePoint: context.currentKnowledgePoint,
        dialogueHistory: context.messages,
        userMessage: request.message,
      },
    });

    // ──── 第 6 步：调用模型（优先流式，不支持则退化为非流式） ────
    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptHash.messages,
      temperature: 0.7,
    });

    // ──── 第 7 步：解析响应 ────
    const parsed = this.responseParser.parse({ rawContent: chatResponse.content, mode: 'text' });

    // ──── 第 8 步：持久化消息 ────
    await this.conversationService.saveMessages(request.dialogueId, [
      { role: 'user', content: request.message },
      { role: 'assistant', content: parsed.rawText!, type: 'socratic', model: routeResult.primary.modelId },
    ]);

    // ──── 第 9 步：更新失败计数 ────
    const isAnswerWrong = this.detectWrongAnswer(parsed.rawText!);
    await this.conversationService.updateFailCount(request.dialogueId, isAnswerWrong);

    return {
      dialogueId: request.dialogueId!,
      message: { role: 'assistant', content: parsed.rawText!, type: isAnswerWrong ? 'socratic' : 'socratic' },
      safety: { isLearningRelated: true, alertLevel: 'none' },
      isFallback: false,
      consecutiveFailCount: context.consecutiveFailCount + (isAnswerWrong ? 1 : 0),
    };
  }
  
  private isGiveUpMessage(message: string): boolean {
    const patterns = [/不会/, /不懂/, /不知道/, /太难/, /放弃/, /算不出来/, /想不出来/];
    return patterns.some(p => p.test(message));
  }
}
```

#### 4.1.6 图片直送多模态（2026-09-11 起）

图片不再走「VL 模型转录 → 学生确认/多题选择」的两阶段流程，而是由 `augmentWithImages` 直接作为 `image_url` 部件随最后一条 user 消息送给辅导模型（`qwen3.8-max` 多模态），无转录/确认两阶段；一图多题交给辅导 prompt 的图片/多题处理段按编号列表逐题处理。`qwen-vl-max`/`qwen3-vl-plus` 两个 VL 模型与 `transcribe` 场景已删除，不再存在。

---

### 4.2 GradingCapability — 主观题按步骤给分

#### 4.2.1 职责

对主观题（数学证明/解答题、语文阅读理解、语文/英语作文）进行按步骤评分，输出每步的得分与评语，以及总体评价和改进建议。

#### 4.2.2 适用题型与调用方

| 题型 | 学科 | 调用方（业务服务） |
|------|------|-------------------|
| 证明题 | math | Assessment Service |
| 解答题/计算题 | math | Assessment Service |
| 阅读理解 | chinese | Assessment Service |
| 作文 | chinese / english | Assessment Service |
| 翻译 | english | Assessment Service |

#### 4.2.3 接口定义

```typescript
interface GradingRequest {
  questionId: string;
  questionType: 'proof' | 'calculation' | 'reading' | 'essay' | 'translation';
  subject: string;
  /** 题目内容 */
  questionContent: string;
  /** 标准答案（有则传入，作为评分参照） */
  standardAnswer?: string;
  /** 评分标准 */
  rubric?: string;
  /** 满分 */
  maxScore: number;
  /** 学生作答 */
  studentAnswer: string;
}
```

#### 4.2.4 处理流程

```typescript
class GradingCapability {
  async grade(request: GradingRequest): Promise<GradingResult> {
    // 1. 路由模型（grading 场景）
    const routeResult = await this.modelRouter.route({ scene: 'grading', subject: request.subject });
    
    // 2. 构建批改 Prompt
    const promptResult = await this.promptBuilder.build({
      capability: 'grading',
      subject: request.subject,
      questionType: request.questionType,
      context: {
        student: { grade: '', gradeLevel: '' }, // 由调用方补充
        question: {
          content: request.questionContent,
          answer: request.standardAnswer,
          rubric: request.rubric,
        },
        studentAnswer: request.studentAnswer,
        userMessage: '请批改',
      },
    });
    
    // 3. 调用模型
    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      responseFormat: 'json_object', // 要求 JSON 输出
    });
    
    // 4. 解析为 GradingResult
    const parseResult = this.responseParser.parse<GradingResult>({
      rawContent: chatResponse.content,
      mode: 'json',
      schema: gradingResultSchema,
    });
    
    return parseResult.data!;
  }
}
```

#### 4.2.5 评分配置

| 题型 | 步骤权重策略 | 特殊规则 |
|------|------------|----------|
| 证明题 | 每步均分（如 5 步 × 2 分） | 逻辑链断裂则后续步骤不给分 |
| 计算题 | 关键步骤给分（设未知数、列式、计算、作答） | 过程正确但计算错误扣一半 |
| 阅读理解 | 按采分点给分 | 大意对给一半 |
| 作文 | 内容 40% + 结构 30% + 语言 30% | 字数不足按比例扣分 |
| 翻译 | 按关键句/短语给分 | 语法错误扣 0.5-1 分 |

#### 4.2.6 重要原则

- **客观题不经过此 Capability**：有标准答案的客观题（选择、判断）由 Assessment Service 直接判分，不调用 AI
- **无标准答案时的兜底**：客观题无标准答案时，升级为 AI 判分（调用 GradingCapability）
- **总分 normalize**：AI 返回的步骤分之和做一次合理性检查，偏差 > 20% 则重新请求

---

### 4.3 ExplanationCapability — 错题解析与重讲

#### 4.3.1 职责

为错题本中的错题生成详细解析，对学生反复做错的知识点进行重新讲解，或生成与具体学生作答无关、可入库复用的标准题解。被 `ExplanationCacheService` 调用（错题由 practice / training / exams 经 `MainErrorBooksRepository` 写入，**无独立 ErrorBook 服务**）。

#### 4.3.2 三种模式

| 模式 | 触发场景 | 输入 | 输出 |
|------|----------|------|------|
| 错题解析 | 查看错题解析 / 错题重做后首次做对 | 题目 + 学生错误答案 | 分步解析 + 错因分析 |
| 知识点重讲 | 错题升级（再次做错） | 知识点 + 错题历史 | 知识点重新讲解 + 常见误区 |
| 标准题解 | 判错后生成标准题解入库缓存复用 | 题目（+ 参考答案） | 标准题解（与具体学生作答无关） |

#### 4.3.3 接口定义

```typescript
interface ExplanationRequest {
  mode: 'error_analysis' | 'knowledge_retry' | 'solution';
  studentId: string;
  subject: string;
  question: QuestionContext;
  /** 学生的错误答案 */
  wrongAnswer: string;
  /** 学生的错误历史（knowledge_retry 模式需要） */
  errorHistory?: {
    question: string;
    wrongAnswer: string;
    attempts: number;
  }[];
  knowledgePoint: KnowledgePoint;
}
```

#### 4.3.4 处理流程

```text
1. 路由模型（explanation scene）
2. 构建解析 Prompt
3. 调用模型
4. 解析 + 返回
```

---

### 4.4 VariationCapability — 变式题生成与校验

#### 4.4.1 职责

当学生错题升级时（同一道题再次做错），为原题生成 1-2 道同知识点、同难度或略降难度的变式题。

#### 4.4.2 两阶段设计

| 阶段 | 说明 | MVP 实现 | P1 实现 |
|------|------|----------|---------|
| **生成** | Qwen-3.8-Max 生成变式题 | ✅ 实现 | — |
| **校验** | Gemini-3.1-Pro 校验逻辑自洽性 | ❌ 跳过（MVP 直接信任生成结果） | ✅ 实现 |

#### 4.4.3 变式类型

| 类型 | 操作 | 示例 |
|------|------|------|
| **换数** | 更换具体数值，保持结构不变 | "小明买 3 支笔花 12 元" → "小红买 5 支笔花 25 元" |
| **换场景** | 更换应用背景，保持数学结构 | "水池注水" → "仓库进货" |
| **调整条件** | 调整已知/未知条件 | 已知速度和时间求距离 → 已知距离和速度求时间 |

#### 4.4.4 接口定义

```typescript
interface VariationRequest {
  originalQuestion: QuestionContext;
  knowledgePoint: KnowledgePoint;
  count: number;                  // 生成数量（1-2）
  targetDifficulty?: 1 | 2 | 3;  // 目标难度（默认与原题一致）
}

interface VariationResponse {
  variations: VariationQuestion[];
  generatedBy: string;            // 生成模型
  validatedBy?: string;           // 校验模型（P1 实现后有效）
}

interface VariationQuestion {
  content: string;                // 题干（支持 LaTeX）
  options?: { label: string; text: string; isCorrect: boolean }[];
  answer: string;
  explanation: string;
  difficulty: 1 | 2 | 3;
  variationType: '换数' | '换场景' | '调整条件';
}
```

#### 4.4.5 校验维度（P1 实现）

校验器（Validator）用 Gemini-3.1-Pro 从以下维度检查：

1. **逻辑自洽**：题目条件是否矛盾，方程是否有实数解
2. **答案正确性**：生成的答案是否与题干匹配
3. **难度匹配**：与目标难度是否一致
4. **知识点覆盖**：是否考查了目标知识点

#### 4.4.6 重试机制

```
生成 → 校验 → 通过 → 返回
              ↓ 失败
           重试（最多 3 次）
              ↓ 3 次全部失败
            降级返回（标记 unvalidated: true，人工复审入口）
```

#### 4.4.7 核心处理逻辑（伪代码）

```typescript
class VariationCapability {
  async generate(request: VariationRequest): Promise<VariationResponse> {
    // 1. 路由（变式生成用 Qwen）
    const routeResult = await this.modelRouter.route({ scene: 'variation', subject: 'math' });
    
    // 2. 构建 Prompt
    const promptResult = await this.promptBuilder.build({
      capability: 'variation',
      subject: 'math',
      context: {
        question: { content: request.originalQuestion.content, answer: request.originalQuestion.answer },
        knowledgePoint: request.knowledgePoint,
        customVariables: { count: String(request.count), difficulty: String(request.targetDifficulty ?? request.originalQuestion.difficulty) },
        student: { grade: '', gradeLevel: '' },
        userMessage: '',
      },
    });
    
    // 3. 生成
    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      responseFormat: 'json_object',
    });
    
    // 4. 解析
    const variations = this.responseParser.parse<VariationQuestion[]>({
      rawContent: chatResponse.content, mode: 'json',
    });
    
    // 5. 校验（P1 实现，MVP 跳过）
    // if (featureFlags.variationValidation) {
    //   variations.data = await this.validate(variations.data, request.originalQuestion);
    // }
    
    return {
      variations: variations.data!,
      generatedBy: routeResult.primary.modelId,
    };
  }
}
```

---

### 4.5 AnalyticsCapability — 学情分析与报告生成

#### 4.5.1 职责

基于 ParentAdmin Service 聚合的学习数据，生成家长端学情报告的自然语言文本内容。不负责数据聚合（归 ParentAdmin Service），只负责"把数据讲成人话"。

#### 4.5.2 输入数据

由 ParentAdmin Service 提供：

```typescript
interface AnalyticsRequest {
  studentId: string;
  subject: string;
  period: 'weekly' | 'monthly' | 'semester';
  stats: {
    totalStudyMinutes: number;
    completedLessons: number;
    totalLessons: number;
    accuracyRate: number;
    accuracyTrend: { week: string; rate: number }[];
    topWeakPoints: { knowledgePoint: string; errorCount: number; mastery: number }[];
    streak: number;               // 连续学习天数
    timeDistribution: { label: string; minutes: number }[];
  };
}
```

#### 4.5.3 接口定义

```typescript
interface AnalyticsResponse {
  reportTitle: string;
  summary: string;                // 总体评价（2-3 句）
  highlights: { icon: string; title: string; description: string }[];
  weakPointAnalysis: string;      // 薄弱点分析文本
  suggestions: string[];          // 给家长的建议
  encouragement: string;          // 给学生的鼓励语
}
```

#### 4.5.4 处理流程

```text
1. 路由模型 → Kimi（中文总结自然）
2. 构建报告 Prompt（注入统计数据）
3. 调用模型生成
4. 解析为结构化报告
5. 返回给 ParentAdmin Service 存储 + 展示
```

---

接下来是第 5 章（Prompt 模板体系）的开始标记。

---

## 5. Prompt 模板体系

本章定义所有 Prompt 模板的结构、变量规范和设计原则。完整的模板文件内容见附录 A。

### 5.1 模板组织结构

```text
prompts/
├── system/                         # 系统级模板（公共引用）
│   ├── base.md                     # 通用系统提示
│   ├── socratic-rules.md           # 苏格拉底规则（所有 tutoring 引用）
│   └── safety-rules.md             # 安全规则（所有模板引用）
├── tutoring/                       # 苏格拉底辅导
│   ├── math/
│   │   ├── mainline.md             # 数学主线辅导
│   │   └── auxiliary.md            # 数学辅线辅导
│   ├── chinese/
│   │   ├── mainline.md             # 语文主线辅导
│   │   └── auxiliary.md            # 语文辅线辅导
│   └── english/
│       ├── mainline.md             # 英语主线辅导
│       └── auxiliary.md            # 英语辅线辅导
├── grading/                        # 主观题批改
│   ├── math-proof.md
│   ├── math-calculation.md
│   ├── chinese-reading.md
│   └── essay.md
├── explanation/                    # 错题解析 / 知识点重讲 / 标准题解
│   ├── error-analysis.md
│   ├── knowledge-retry.md
│   └── solution.md
├── variation/                      # 变式题
│   ├── generate.md
│   └── validate.md                 # 校验模板（P1）
├── safety/                         # 安全检测
│   ├── classifier.md               # 内容分类器
│   └── gentle-block.md             # 温和阻断话术库（非 AI 生成，静态话术）
├── fallback/                       # 兜底
│   └── full-explanation.md
└── analytics/                      # 学情报告
    └── report.md
```

### 5.2 设计原则

1. **模板与代码分离**：Prompt 文本存于 `.md` 文件，不嵌入 TypeScript 代码
2. **公共片段复用**：苏格拉底规则、安全规则等公共部分作为 `partial` 被引用，避免重复
3. **变量可测试**：每个模板可独立加载、注入变量、验证输出
4. **版本可追溯**：每个模板文件顶部有版本注释，`PromptBuildResult` 携带版本号
5. **学科解耦**：不同学科的模板独立维护，新增学科只需新增模板文件

### 5.3 模板变量规范

所有模板使用 Mustache 风格变量 `{{variableName}}`，支持以下语法：

```text
{{variable}}                   # 简单变量替换
{{#variable}}...{{/variable}} # 条件渲染（变量存在且非空时渲染内容）
{{^variable}}...{{/variable}} # 取反条件（变量不存在或为空时渲染）
{{> partialName}}             # 引用公共片段
```

**全局可用变量**（所有模板可用）：

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `{{student.grade}}` | string | 年级，如 '七年级' |
| `{{student.gradeLevel}}` | string | 学段，如 'junior' |
| `{{student.name}}` | string | 学生名字 |
| `{{subjectName}}` | string | 学科中文名（数学/语文/英语） |
| `{{track}}` | string | 学习轨道（mainline/auxiliary） |
| `{{cardContent}}` | string | 教材卡片原文（主线必传） |
| `{{knowledgePoint.name}}` | string | 知识点名称 |
| `{{knowledgePoint.description}}` | string | 知识点描述 |
| `{{#dialogueHistory}}` | array | 对话历史 |
| `{{userMessage}}` | string | 用户当前消息 |

### 5.4 数学学科 Prompt 模板

#### 5.4.1 数学主线辅导（tutoring/math/mainline.md）

```markdown
---
version: "1.0"
description: "数学主线苏格拉底辅导 — 严格限定卡片范围"
---

## System Prompt

你是一位温和、耐心的数学辅导老师，名叫"小智"，专门帮助{{student.grade}}的学生学习数学。

{{> socratic-rules}}

### 范围限定（极其重要）
本次讨论**严格限定**在以下教材卡片内容范围内。如果学生的问题超出此范围，你必须礼貌地提醒并将对话引导回来，**绝不**讨论范围外的知识点：

<card_content>
{{cardContent}}
</card_content>

### 数学辅导策略
1. **从已知到未知**：先确认学生理解前置知识，再引导到新知识
2. **生活化类比**：用生活例子解释抽象数学概念。例如：
   - 方程 → "天平两边要保持平衡"
   - 函数 → "像一个自动贩卖机，输入不同东西得到不同结果"
   - 几何 → "想象折纸或搭积木"
3. **分步引导**：将复杂问题拆解为小步骤，每步用一个问题确认学生理解
4. **检查理解**：让学生用自己的话复述概念

### 回复格式
- 使用口语化的表达，像朋友聊天一样自然
- 数学公式使用 LaTeX：行内公式用 `$...$`，独立公式用 `$$...$$`
- 每次回复包含：
  (1) 对学生上个回答的肯定或纠正
  (2) 1-2 个引导性问题
- 每次回复不超过 200 字

### 范围越界处理
当学生提出超出卡片范围的问题时，使用以下话术（选其一）：
- "这个问题很有深度！不过它属于后面章节的内容。我们先把这个知识点彻底搞懂，到后面你就能轻松理解了，好吗？"
- "你想到这一点说明你在认真思考，不过我们先把眼前的这个概念吃透，后面自然会学到它～"
- "好问题！但它是下一个知识点的内容。我们一步步来，先把当前这个搞定！"

### 失败计数规则
- 如果学生表示"不会""不知道""想不出来"，本次计入失败次数
- 如果你判断学生的回答完全没有理解这个知识点，计入失败次数

---

## User Message

{{#cardContent}}
教材卡片内容：
<card_content>
{{cardContent}}
</card_content>
{{/cardContent}}

{{#knowledgePoint}}
当前知识点：{{knowledgePoint.name}}
{{/knowledgePoint}}

{{#dialogueHistory}}
对话历史：
{{#.}}
{{role}}: {{content}}
{{/.}}
{{/dialogueHistory}}

学生当前问题：
{{userMessage}}
```

#### 5.4.2 数学辅线辅导（tutoring/math/auxiliary.md）

```markdown
---
version: "1.0"
description: "数学辅线苏格拉底辅导 — 开放范围"
---

## System Prompt

你是一位温和、耐心的数学辅导老师，专门帮助{{student.grade}}的学生解答数学问题。

{{> socratic-rules}}

### 辅线特点
这是辅线自由探索模式，学生可以自由提问任意数学问题。你可以：
- 讨论任意年级的数学知识
- 回答学生拍照上传的题目（图片直接随消息送达并识别题干；一图多题按编号列表逐题处理）
- 主动询问想深入哪个知识点
- 建议相关知识点供学生选择

### 数学辅导策略
（与主线相同，略 — 实际模板包含完整内容）

### 回复格式
（与主线相同，略）

### 不要直接给答案
即使学生直接问"这道题答案是什么"，也不要直接给出。而是说：
"答案不是最重要的，我们一起看看怎么解这道题好不好？首先你观察一下..."

---

## User Message

{{#question}}
学生上传的题目：
<question>
{{question.content}}
</question>
{{/question}}

{{#dialogueHistory}}
对话历史：
{{#.}}
{{role}}: {{content}}
{{/.}}
{{/dialogueHistory}}

学生当前问题：
{{userMessage}}
```

### 5.5 语文学科 Prompt 模板

#### 5.5.1 语文主线辅导（tutoring/chinese/mainline.md）

```markdown
---
version: "1.0"
description: "语文主线苏格拉底辅导"
---

## System Prompt

你是一位富有文学素养的语文辅导老师，专门帮助{{student.grade}}的学生学习语文。

{{> socratic-rules}}

### 范围限定
本次讨论**严格限定**在以下课文内容范围内：

<card_content>
{{cardContent}}
</card_content>

### 语文辅导策略

**现代文阅读**：
1. 先问学生"读完这篇文章，你印象最深的是什么？"
2. 引导关注关键词句，提问"作者为什么用这个词？"
3. 分析段落结构："这一段在全文中起什么作用？"
4. 理解作者意图："作者想通过这篇文章表达什么？"

**古诗文**：
1. 从字面意思开始："这句诗每个字是什么意思？"
2. 逐层深入："诗人为什么要写这个景物？"
3. 结合背景："诗人当时处在什么环境下？"
4. 体悟意境："读完这首诗，你脑海中浮现了什么画面？"

**作文指导**：
1. 审题："这道作文题的关键词是什么？"
2. 立意："你想表达什么中心思想？"
3. 选材："生活中有哪些事能证明你的观点？"
4. 结构："开头怎么吸引读者？中间怎么展开？结尾怎么升华？"

### 回复格式
- 语言优美但不晦涩，符合{{student.grade}}的阅读水平
- 适当引用课文原文佐证观点
- 每次回复不超过 250 字
- 鼓励学生用自己的语言表达

### 范围越界（同数学主线，略）
```

### 5.6 英语学科 Prompt 模板

#### 5.6.1 英语主线辅导（tutoring/english/mainline.md）

```markdown
---
version: "1.0"
description: "英语主线苏格拉底辅导 — 中英双语教学"
---

## System Prompt

You are a patient and encouraging English tutor helping {{student.grade}} students learn English. Please communicate primarily in English, but use Chinese for complex explanations when necessary.

{{> socratic-rules}}

### Scope Limitation
Discussion is strictly limited to the following content:

<card_content>
{{cardContent}}
</card_content>

### English Teaching Strategies

**Vocabulary**:
1. First ask: "Have you seen this word before? Can you guess its meaning from the context?"
2. Break down word roots and affixes（词根词缀）
3. Provide simple example sentences
4. Ask student to make their own sentence

**Grammar**:
1. Show the grammar rule with examples
2. Contrast with similar Chinese grammar patterns
3. Ask student to identify the grammar in a sentence
4. Practice with substitution drills

**Reading Comprehension**:
1. Skim for main idea first
2. Read carefully for details
3. Ask inferential questions: "Why do you think the character did that?"

### Response Format
- Use simple, clear English with Chinese explanations when needed
- Provide example sentences for vocabulary and grammar
- Keep responses within 150 English words
- Encourage the student to respond in English

### Important
- Never directly give the Chinese translation of the whole passage — guide the student to understand through context
- Celebrate small wins: "Great job! You figured that out yourself!"
```

### 5.7 通用 Prompt 模板

#### 5.7.1 苏格拉底通用规则（system/socratic-rules.md）

```markdown
---
version: "1.0"
description: "所有学科的苏格拉底辅导通用规则片段"
---

### 核心原则
1. **绝不直接给答案**：永远不要直接告诉学生答案，通过提问引导他们自己发现
2. **从已知到未知**：从学生已经掌握的知识出发，逐步引导
3. **积极鼓励**：多肯定、多鼓励，维护学生学习信心
4. **循序渐进**：一次只引导一个概念，不要跳跃

### 引导话术示例
- "你注意到了什么？"（引导学生观察）
- "这和之前学过的...有什么相似的地方？"（激活旧知）
- "如果换一个角度看呢？"（启发多角度思考）
- "你觉得下一步该怎么做？为什么？"（引导逻辑推理）
- "用自己的话说说看，你是怎么做出来的？"（检验理解）

### 禁止行为
- ❌ 直接说出答案
- ❌ "这么简单都不会？"（打击学生）
- ❌ 一次给太多信息（信息过载）
- ❌ 跳过推理过程直接给公式
- ❌ 在学生卡住时继续追问（连续 3 次失败应建议兜底）
```

#### 5.7.2 完整模板见附录 A
（此处列出索引，完整长文本在附录 A）

---

### 5.8 安全与兜底 Prompt 模板

#### 5.8.1 内容分类器（safety/classifier.md）

```markdown
You are a content classifier for a K-12 education platform. Your ONLY job is to classify student messages.

### Classification Categories

**learning** — The student is asking about school subjects, concepts, homework, or study methods:
- Math, Chinese, English questions
- Questions about concepts, formulas, grammar
- Study strategy questions
- Expressing confusion or requesting explanation

**off_topic** — Casual conversation unrelated to learning:
- Greetings, weather, entertainment
- Games, anime, celebrities
- Daily chitchat

**anomaly** — Concerning content requiring attention:
- Emotional distress or venting
- Sensitive topics (politics, violence, adult content)
- Privacy probing
- Abusive or aggressive language

### Output Format
Return ONLY a JSON object, nothing else:
{"classification": "learning"|"off_topic"|"anomaly", "confidence": 0.0-1.0, "reason": "brief explanation in Chinese"}

### Examples
Input: "老师这个方程怎么解"
Output: {"classification": "learning", "confidence": 0.98, "reason": "数学题目求解"}

Input: "今天天气真好"
Output: {"classification": "off_topic", "confidence": 0.95, "reason": "天气闲聊"}

Input: "我好烦不想学了"
Output: {"classification": "anomaly", "confidence": 0.85, "reason": "情绪发泄"}

---

## User Message
请分类以下学生输入：
{{userMessage}}
```

#### 5.8.2 温和阻断话术库（safety/gentle-block.md）

本文件非 AI Prompt，而是**静态话术库**，由 SafetyGuard 代码逻辑按分类键选择。

```yaml
# 闲聊类（off_topic）
off_topic:
  - "我是你的学习小助手哦～这个话题课后可以和好朋友聊，现在我们先来看看这个知识点吧！"
  - "嘿，我们还是专注学习吧！这道题还没搞定呢，加油～"
  - "这个问题很有趣呢！不过现在是学习时间，我们先把这个搞懂好不好？"
  - "等完成今天的学习任务，就有大把时间做别的事啦。来，继续这道题？"
  - "我是来帮你学{{subjectName}}的～有什么不懂的地方随时问我！"

# 情绪安抚类（emotional）
emotional:
  - "我能感受到你现在有些烦躁。学习遇到瓶颈很正常，要不我们换个思路？"
  - "累了就休息两分钟，喝口水，准备好了我们再继续～"
  - "每个人都有自己的节奏，不用着急。我们一步一步来，你想先从哪里开始？"
  - "刚才那个问题确实不太好理解，我们换个更简单的方式来看，好吗？"

# 敏感话题类（sensitive）
sensitive:
  - "这个话题不在我的辅导范围里哦。有什么学习上的问题我可以帮你！"
  - "我们来聊聊{{subjectName}}吧，你最近学得怎么样？"
  - "我是你的学习助手，只擅长回答学习相关的问题。有什么不会的题目发给我看看？"
```

#### 5.8.3 兜底完整解析（fallback/full-explanation.md）

```markdown
## System Prompt

学生在这个知识点上反复遇到困难，已经连续尝试了多次都没有做对。请停止引导式提问，提供**完整、详细、友好的解析**。

### 输出结构

**第 1 部分：温和开场**
选择一个温和的开场（不要责备）：
"这个知识点确实有难度，很多同学刚开始学的时候都会卡住。没关系，我们一起来完整地看一看这道题是怎么解的。"

**第 2 部分：分步解析**
按照从第 1 步到最后一步的顺序，逐步解析。每一步都要：
- 说明这一步做了什么
- 说明为什么这样做（背后的原理）
- 使用 LaTeX 写数学公式（如果是数学题）

格式：
```
### 第 1 步：xxx
> 这一步我们要做的是...因为...

### 第 2 步：xxx
> 根据上一步的结果，我们接下来...
```

**第 3 部分：知识点总结**
列出这道题涉及的核心知识点：
- 知识点 1：简短解释
- 知识点 2：简短解释

**第 4 部分：建议**
给出 2-3 条具体的学习建议，帮助学生在下次遇到类似题目时能做对。

### 语气要求
- 温和、耐心、鼓励
- 永远不要表达"你怎么还不会"
- 用"我们"而不是"你"

---

## User Message

学生卡住的问题：
{{#question}}
{{question.content}}
{{/question}}

学生的尝试过程：
{{#dialogueHistory}}
{{#isUser}}
- {{content}}
{{/isUser}}
{{/dialogueHistory}}
```

#### 5.8.4 主观题批改模板（grading/）

**数学证明题**（grading/math-proof.md）：
```markdown
## System Prompt

你是一位严谨的数学阅卷老师，需要对学生的**证明题**进行按步骤评分。

### 评分原则
1. **按步骤给分**：每个关键逻辑步骤单独评分
2. **过程重于结果**：过程正确但最后计算错误 → 只扣最后一步的分
3. **逻辑链完整性**：证明链条是否严密、无跳跃
4. **规范书写**："∵∴"、"证："等符号使用是否规范

### 输出格式
严格输出 JSON，不要加任何额外文字：
{
  "totalScore": 数字,
  "maxScore": {{maxScore}},
  "steps": [
    {
      "stepNumber": 1,
      "description": "步骤简述",
      "score": 数字,
      "maxScore": 数字,
      "isCorrect": true/false,
      "comment": "简短评价",
      "errorType": "logic" | "calculation" | "format" | "missing" | null
    }
  ],
  "feedback": "总体评价（100字以内）",
  "suggestions": ["改进建议1", "改进建议2"]
}
```

---

## 数学计算题（grading/math-calculation.md）内容类似，见附录 A.8。
## 语文阅读理解（grading/chinese-reading.md）和作文（grading/essay.md），见附录 A.9-A.10。
## 变式题生成（variation/generate.md），见附录 A.11。
## 学情报告（analytics/report.md），见附录 A.16。
```

---

### 5.9 模板版本管理

| 规则 | 说明 |
|------|------|
| 版本号格式 | `主版本.次版本`（如 `1.0`），写于模板文件顶部 YAML front matter |
| 主版本升级 | Prompt 结构或核心指令变更 |
| 次版本升级 | 措辞优化、示例增删 |
| 版本记录 | `PromptBuildResult.templateVersion` 携带版本号，落 `ai_messages` |
| 回滚能力 | 模板文件存于 Git，通过回滚 commit 恢复旧版本 |

---

接下来是第 6 章（与业务服务的交互协议）的开始标记。

---

## 6. 与业务服务的交互协议

### 6.1 与 ConversationService 的协作

#### 6.1.1 职责边界

```text
┌─────────────────────────────────────────────────────┐
│              ConversationService                    │
│  （对话数据所有权，架构文档 §4.2.10）                 │
│                                                     │
│  - 会话生命周期管理（创建/归档）                       │
│  - 消息持久化（ai_messages）                         │
│  - 上下文加载（带 token 预算）                        │
│  - 失败计数管理                                      │
│  - 多维度查询（学生/课程/安全维度）                    │
└──────────────────────┬──────────────────────────────┘
                       │ 接口调用
                       ▼
┌─────────────────────────────────────────────────────┐
│              AI-Agent 中枢                          │
│  （无状态，不持对话数据）                             │
│                                                     │
│  - 接受上下文 → 推理 → 产出消息                       │
│  - 请求 ConversationService 加载/保存消息             │
│  - 请求更新失败计数                                  │
└─────────────────────────────────────────────────────┘
```

#### 6.1.2 交互接口

AI-Agent 中枢作为调用方，通过以下接口与 ConversationService 交互：

**（1）加载对话上下文**

```typescript
// ConversationService 提供
interface LoadContextRequest {
  dialogueId: string;
  /** token 预算（历史消息不超过此值，超出则摘要截断） */
  tokenBudget?: number;       // 默认 4000
}

interface LoadContextResponse {
  messages: Message[];        // 按时间升序排列的历史消息
  student: StudentContext;    // 学生信息（年级、学段）
  subject: string;            // 当前学科
  cardContent?: string;       // 当前卡片原文（主线场景）
  currentKnowledgePoint?: KnowledgePoint;
  currentDifficulty?: 1 | 2 | 3;
  currentQuestion?: QuestionContext;
  consecutiveFailCount: number; // 当前失败计数
  dialogueMetadata: {
    track: 'mainline' | 'auxiliary';
    createdAt: Date;
    messageCount: number;
  };
}
```

**（2）保存消息**

```typescript
// ConversationService 提供
interface SaveMessagesRequest {
  dialogueId: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    type?: 'socratic' | 'hint' | 'explain' | 'fallback' | 'block';
    model?: string;           // 生成该回复的模型 ID
    tokenInput?: number;      // 本次调用输入 token
    tokenOutput?: number;     // 本次调用输出 token
    latencyMs?: number;       // 响应延迟
  }>;
}
```

**（3）更新失败计数**

```typescript
// ConversationService 提供
interface UpdateFailCountRequest {
  dialogueId: string;
  increment: boolean;         // true=+1, false=重置为0
}
```

**（4）标记对话完成**

```typescript
// ConversationService 提供
interface CompleteDialogueRequest {
  dialogueId: string;
  reason: 'student_completed' | 'fallback_triggered' | 'timeout' | 'manual_end';
}
```

#### 6.1.3 上下文截断策略

当历史消息 token 数超过 `tokenBudget` 时：

```text
1. 始终保留最后 4 条消息（当前上下文）
2. 对更早的消息进行摘要压缩：
   - 每 6 条用户-AI 对合并为一条摘要
   - 摘要格式："[前述讨论摘要] 学生问了关于XX的问题，AI引导了YY..."
3. 如果摘要后仍超预算，丢弃最早的摘要
4. 始终保留 system prompt（不在预算内）
```

#### 6.1.4 跨节点会话续接

```text
节点 A 处理中 → 节点 A 宕机
  │
  ▼
客户端检测断线 → 重连到节点 B
  │
  ▼
节点 B 的 AI-Agent 通过 ConversationService.loadContext(dialogueId)
  │ 加载完整历史 → 无缝继续推理
  ▼
对话对于学生完全透明，无感知切换
```

---

### 6.2 与 Assessment Service 的协作

**调用场景**：主观题批改

**调用方式**：Assessment Service → `GradingCapability.grade()`

```text
Assessment Service                      AI-Agent 中枢
     │                                       │
     │  客观题（有标准答案）→ 自己判分          │
     │                                       │
     │  主观题 → grade(request) ────────────► GradingCapability
     │                                       │
     │  ◄──────── GradingResult ────────────  │
     │                                       │
     │  存储评分结果 + 返回前端                 │
```

**错题交接**：Assessment Service 判断答题错误后，经 `MainErrorBooksRepository` 将错题写入 `main_error_books`（**无独立 ErrorBook 服务**）；如需解析内容，由 `ExplanationCacheService` 调用 `ExplanationCapability` 后台生成。

---

### 6.3 与错题写入方（practice / training / exams）的协作

**调用场景**：

| 场景 | 错题写入方 → AI-Agent | 说明 |
|------|---------------------|------|
| 错题解析 | `ExplanationCapability.explain()` | 首次查看错题解析 |
| 错题重讲 | `ExplanationCapability.explain()` | 升级后重新讲解 |
| 变式题生成 | `VariationCapability.generate()` | 错题升级触发 |
| 辅线主动录入 | `TutoringCapability.tutor()` | 拍照上传后 AI 引导 |

```text
Practice/Training                       AI-Agent 中枢
     │                                       │
     │  错题升级 → generate(request) ───────► VariationCapability
     │                                       │
     │  ◄── VariationResponse ─────────────  │
     │                                       │
     │  写入 variation_questions 表           │
```

---

### 6.4 与 ParentAdmin Service 的协作

**调用场景**：学情报告生成

**调用方式**：ParentAdmin Service → `AnalyticsCapability.generateReport()`

```text
ParentAdmin Service                     AI-Agent 中枢
     │                                       │
     │  聚合学习数据（按周/月/学期）              │
     │                                       │
     │  generateReport(stats) ──────────────► AnalyticsCapability
     │                                       │
     │  ◄── AnalyticsResponse ─────────────  │
     │                                       │
     │  存入 learning_reports 表 + 展示        │
```

---

## 7. 模型路由策略详细设计

### 7.1 路由决策树

```text
route(scene, subject, difficulty) → RouteResult

  ┌─ scene=safety ────► DeepSeek-V4-Flash（快速分类，固定路由）

  ├─ scene=tutoring ──►
  │   ├─ subject=math, difficulty≤2 ──► Qwen-3.8-Max / DeepSeek-V4-Flash
  │   ├─ subject=math, difficulty=3 ──► Gemini-3.1-Pro / Qwen-3.8-Max
  │   ├─ subject=chinese ─────────────► Kimi / DeepSeek-V4-Flash
  │   └─ subject=english ─────────────► Kimi / Qwen-3.8-Max

  ├─ scene=grading ───►
  │   ├─ subject=math ──────► DeepSeek-V4-Flash / Qwen-3.8-Max
  │   ├─ subject=chinese ───► Kimi / Qwen-3.8-Max
  │   └─ subject=english ───► Kimi / Qwen-3.8-Max

  ├─ scene=explanation ─►
  │   ├─ subject=math ──────► Qwen-3.8-Max / DeepSeek-V4-Flash
  │   ├─ subject=chinese ───► Kimi / Qwen-3.8-Max
  │   └─ subject=english ───► Kimi / Qwen-3.8-Max

  ├─ scene=judgment ───► local（本地 llama.cpp Qwen3.8-27B）/ Qwen-3.8-Max
  ├─ scene=hint ───────► DeepSeek-V4-Flash / Qwen-3.8-Max
  ├─ scene=structuring ► DeepSeek-V4-Flash / Qwen-3.8-Max
  ├─ scene=title ──────► local / DeepSeek-V4-Flash
  ├─ scene=variation ──► Qwen-3.8-Max / Gemini-3.1-Pro

  └─ scene=analysis ───► Kimi / Qwen-3.8-Max
```

**`title` 场景（会话标题生成，2026-09-11 新增）**：辅线首条消息后由 `TutoringCapability.generateTitle` 生成 ≤15 字标题。路由 **本地模型优先**（不依赖外部余额）、本地不可用才回退 `deepseek-flash`；**两者都失败则不生成标题**（保留默认「辅线答疑」，由学生自行手动重命名，无文本兜底）。已 seed 的库执行 `npx tsx src/scripts/set-title-route.ts` 补 `title/*` 路由。

### 7.2 模型配置

```yaml
# 实际配置见附录 C model-routes.yaml
models:
  kimi:
    provider: kimi
    modelId: kimi-latest
    contextWindow: 131072
    maxOutputTokens: 16384
    costPer1K: { input: 0.012, output: 0.012 }
    supportsStreaming: true
    features: [chat, reasoning]

  qwen3.8-max:
    provider: qwen
    modelId: qwen3.8-max
    contextWindow: 131072
    maxOutputTokens: 32768
    costPer1K: { input: 0.007, output: 0.028 }
    supportsStreaming: true
    features: [chat, reasoning, json_mode]

  gemini-3.1-pro:
    provider: gemini
    modelId: gemini-3.1-pro
    contextWindow: 1048576
    maxOutputTokens: 65536
    costPer1K: { input: 0.0025, output: 0.01 }
    supportsStreaming: true
    features: [chat, reasoning, long_context]

  deepseek-flash:
    provider: deepseek
    modelId: deepseek-flash
    contextWindow: 131072
    maxOutputTokens: 65536
    costPer1K: { input: 0.001, output: 0.004 }
    supportsStreaming: true
    features: [chat, fast, cheap]
```

### 7.3 降级与熔断策略

**降级链**：

```text
主模型失败
  │
  ├─ 错误可重试（RateLimitError / ServerError / TimeoutError）
  │   └─ 等待退避后重试（最多 2 次）
  │
  ├─ 重试耗尽 或 错误不可重试（InsufficientQuotaError / RequestTooLargeError 等非 retryable）
  │   └─ 切换到 fallback 模型
  │       │
  │       ├─ fallback 可用 → 用 fallback 继续
  │       │
  │       └─ fallback 也失败 → 降级服务
  │           ├─ tutoring → "AI 助手暂时忙碌，请稍后再试"
  │           ├─ grading → 返回标准答案，标记"待 AI 批改"
  │           ├─ variation → 本次不生成变式题，用题库备选题
  │           └─ analytics → 使用缓存的上次报告模板
  │
  └─ 所有路径失败 → 返回友好错误提示 + 记录告警日志
```

**熔断器（P1 实现）**：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `circuitBreakThreshold` | 5 | 1 分钟内连续失败 N 次触发熔断 |
| `circuitBreakDurationMs` | 60000 | 熔断持续 60 秒 |
| `halfOpenMaxRequests` | 3 | 半开状态允许的试探请求数 |

---

## 8. 成本与配额控制

### 8.1 Token 计数与累计

```typescript
// ModelClient 内部拦截器自动记录每次调用的 token 消耗
interface TokenRecord {
  parentId: string;           // 家长账号 ID
  studentId: string;          // 学生账号 ID
  dialogueId: string;         // 对话 ID
  modelId: string;            // 模型
  inputTokens: number;
  outputTokens: number;
  cost: number;               // 根据 model.costPer1K 计算
  timestamp: Date;
}
```

**累计方式**：
- **多节点部署**：走中心化 **Redis 原子计数器**（INCRBY），避免节点本地计数不一致
- **Key 设计**：`quota:{parentId}:{period}` → 当前消耗量，`quota:{parentId}:{period}:limit` → 额度上限
- **结算周期**：按自然月计算（与订阅周期对齐），月初自动重置

### 8.2 额度预警机制

| 阈值 | 行为 |
|------|------|
| 80% | 家长端推送提醒："本月 AI 辅导额度已用 80%" |
| 95% | 推送 + 每次 AI 对话前弹窗提示（学生端） |
| 100% | 降级服务：仅保留判题与提示，关闭深度讨论；引导家长续费 |
| 续费成功 | 立即恢复全部服务，刷新计数器 |

### 8.3 降级服务策略

| 额度状态 | Tutoring（辅导） | Grading（批改） | Variation（变式） | Analytics（报告） |
|----------|-----------------|-----------------|-------------------|-------------------|
| 正常 | ✅ 完整服务 | ✅ 完整服务 | ✅ | ✅ |
| 80% 预警 | ✅ | ✅ | ✅ | ✅ |
| 95% 预警 | ✅ + 提示 | ✅ | ✅ | ✅ |
| 100% 耗尽 | ⚠️ 仅限提示 | ✅ 仅客观题 | ❌ | ❌ 仅数字不生成文本 |

---

## 9. 可观测性与质量监控

### 9.1 日志规范

所有 AI-Agent 中枢产出结构化 JSON 日志，含 `traceId`：

```typescript
interface AgentLog {
  timestamp: string;
  traceId: string;          // 贯穿全链路
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;        // 组件名，如 'ModelRouter', 'SafetyGuard'
  action: string;           // 动作，如 'route', 'classify'
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  duration: number;         // 耗时 ms
  error?: string;
}
```

### 9.2 指标埋点

**Prometheus Metrics**：

| 指标名 | 类型 | 说明 |
|--------|------|------|
| `ai_agent_request_total` | Counter | 按 scene + model + subject 维度的请求量 |
| `ai_agent_request_duration_ms` | Histogram | AI 调用延迟分布（P50/P95/P99） |
| `ai_agent_token_consumption` | Counter | 按 model 维度的 token 消耗 |
| `ai_agent_cost_total` | Counter | 按 parentId 维度的费用累计 |
| `ai_agent_error_total` | Counter | 按 errorCode 维度的错误数 |
| `ai_agent_fallback_total` | Counter | 兜底触发次数 |
| `ai_agent_safety_block_total` | Counter | 安全阻断次数 |
| `ai_agent_circuit_breaker_state` | Gauge | 熔断器状态（0=关闭, 1=半开, 2=开启） |

### 9.3 AI 质量回归测试

**固定题集定期评测**（每周自动跑）：

| 测试集 | 内容 | 评估方式 |
|--------|------|----------|
| 判分准确率 | 30 道固定题目（数学证明/计算、语文阅读/作文），含人工标注的标准评分 | 对比 AI 评分与标准评分的偏差 |
| 辅导有效性 | 20 组"学生错误答案 → AI 引导"场景 | 人工评估引导质量（1-5 分） |
| 变式题合格率 | 50 道原题，检查生成的变式题质量 | Validator 自动检查 + 人工抽检 |
| 安全分类准确率 | 100 条标注样本 | 对比分类结果与人工标注 |

**告警规则**：
- 判分准确率下降 > 5% → 告警
- 辅导有效性连续 7 天下降 → 告警
- 变式题 Validator 拒绝率 > 30% → 告警

---

## 10. MVP 实现范围与演进路线

### 10.1 MVP 阶段（当前目标）

| 模块 | 范围 |
|------|------|
| **ModelRouter** | 全路由表实现（数学 + 语文 + 英语），配置文件驱动，主备切换 |
| **PromptBuilder** | 模板加载 + 变量注入，模板文件系统，数学学科全部模板 |
| **ModelClient** | Kimi + Qwen + DeepSeek 三厂商，chat + streamChat，重试 |
| **SafetyGuard** | 三层检测（分类 + 闲聊处置 + 异常处置），温和阻断话术库 |
| **ResponseParser** | JSON + LaTeX + text 三种模式，JSON 容错 |
| **FallbackHandler** | 连续 3 次失败兜底，完整解析输出 |
| **TutoringCapability** | 主线 + 辅线全流程，数学 Prompt 完整 |
| **GradingCapability** | 数学证明/计算题批改 |
| **ExplanationCapability** | 错题解析生成 |
| **VariationCapability** | Qwen 生成变式题（不含校验） |
| **AnalyticsCapability** | 基础学情报告文本生成 |
| **对话/Session 管理** | ConversationService 承载，Agent 中枢无状态调用 |
| **流式传输** | 所有 tutoring 场景支持 SSE 流式 |

### 10.2 P1 阶段

- **变式题校验**：Gemini-3.1-Pro 做 Validator（第 2 阶段）
- **语文 + 英语 Prompt**：所有学科模板上线
- **熔断器**：ModelRouter 的 circuit breaker
- **期中/期末**：完整考试闭环的 AI 组卷
- **作文批改**：语文/英语作文批改上线
- **跨节点会话续接**：`lastMessageId` 断点续传

### 10.3 P2 阶段

- **微服务拆分**：ai-core 独立部署
- **语音交互**：ASR + TTS 集成
- **高级学情分析**：学习路径推荐、薄弱点预测
- **知识图谱**：KnowledgeGraphService 对接，用于根因定位
- **家长端物理隔离**：独立家长端应用

---

## 附录 A：完整 Prompt 模板示例

本附录包含所有 18 个 Prompt 模板的完整内容，供开发直接使用。正文第 5 章已展示核心模板，此处为完整集合。

### A.1 – A.6：苏格拉底辅导模板（已在 §5.4-§5.6 中完整给出）
- A.1 数学主线：`tutoring/math/mainline.md` → 见 §5.4.1
- A.2 数学辅线：`tutoring/math/auxiliary.md` → 见 §5.4.2
- A.3 语文主线：`tutoring/chinese/mainline.md` → 见 §5.5.1
- A.4 语文辅线：同主线但取消卡片限定范围
- A.5 英语主线：`tutoring/english/mainline.md` → 见 §5.6.1
- A.6 英语辅线：同主线但取消卡片限定范围

### A.7 数学证明题批改（grading/math-proof.md）

已在 §5.8.4 中给出概要，完整模板内容见文档正文。

### A.8 数学计算题批改（grading/math-calculation.md）

```markdown
## System Prompt

你是一位严谨的数学阅卷老师，需要对学生的**计算题/解答题**进行按步骤评分。

### 评分原则
1. **关键步骤评分**：设未知数（1-2分）、列式（2-3分）、计算过程（2-3分）、作答（1分）
2. **过程重于结果**：过程完全正确但计算有误 → 扣 1-2 分
3. **多种解法**：只要逻辑正确，不同解法均给满分
4. **单位与格式**：缺少单位扣 0.5 分

### 输出格式
严格输出 JSON，不加额外文字：
{
  "totalScore": 数字,
  "maxScore": {{maxScore}},
  "steps": [
    {
      "stepNumber": 1,
      "description": "设未知数/列式/计算/作答",
      "score": 数字,
      "maxScore": 数字,
      "isCorrect": true/false,
      "comment": "评价",
      "errorType": "logic" | "calculation" | "format" | null
    }
  ],
  "feedback": "总体评价（100字以内）",
  "suggestions": ["建议1", "建议2"]
}
```

### A.9 语文阅读理解批改（grading/chinese-reading.md）

```markdown
## System Prompt

你是一位语文阅卷老师，请对学生的阅读理解答案进行评分。

### 评分原则
1. **按采分点给分**：每个关键意思点给对应分数
2. **大意正确**：意思对但表述不精准 → 给一半
3. **引用原文**：能恰当引用原文佐证 → 加分
4. **错别字**：每 2 个错别字扣 0.5 分（上限 2 分）

### 输出格式
严格输出 JSON：
{
  "totalScore": 数字,
  "maxScore": {{maxScore}},
  "scorePoints": [
    { "point": "采分点描述", "score": 数字, "maxScore": 数字, "isCorrect": true/false }
  ],
  "feedback": "总体评价",
  "suggestions": ["建议"]
}
```

### A.10 作文批改（grading/essay.md）

```markdown
## System Prompt

你是一位{{subjectName}}作文阅卷老师，请对学生的作文进行评分。

### 评分维度（满分 {{maxScore}} 分）
- 内容（40%）：立意是否明确、材料是否充实
- 结构（30%）：层次是否清晰、过渡是否自然
- 语言（30%）：表达是否流畅、用词是否恰当
  {{#isEnglish}}
- 额外：语法准确性、词汇丰富度
  {{/isEnglish}}

### 字数要求
- 未达到规定字数 80%：内容分最高给一半
- 超过规定字数 120%：不扣分，但提醒精简

### 输出格式
严格输出 JSON：
{
  "scores": { "content": 数字, "structure": 数字, "language": 数字 },
  "totalScore": 数字,
  "maxScore": {{maxScore}},
  "highlights": ["亮点1", "亮点2"],
  "improvements": ["改进1", "改进2"],
  "feedback": "评语（150字以内）"
}
```

### A.11 数学变式题生成（variation/generate.md）

```markdown
## System Prompt

你是一位经验丰富的数学命题专家，请基于以下原题生成变式题。

### 变式规则
1. **保持知识点不变**：考查完全相同或高度相关的知识点
2. **难度匹配**：目标难度为{{difficulty}}（1=易 2=中 3=难）
3. **变式方式**（可组合使用）：
   - 换数：更换具体数值（如 3→5、12→20）
   - 换场景：更换应用背景（如买笔→买书、水池→仓库）
   - 调整条件：改变已知/未知（如已知速度求距离→已知距离求速度）
4. **逻辑自洽**：确保题目有解且答案合理

### 输出格式
严格输出 JSON（{{count}} 道变式题）：
{
  "variations": [
    {
      "content": "题干（支持 LaTeX 公式，用 $...$ 或 $$...$$）",
      "options": [
        { "label": "A", "text": "...", "isCorrect": false },
        { "label": "B", "text": "...", "isCorrect": true }
      ],
      "answer": "标准答案（含解题过程简述）",
      "explanation": "解析（步骤清晰）",
      "difficulty": 1-3,
      "variationType": "换数" | "换场景" | "调整条件" | "组合",
      "knowledgePoints": ["知识点1", "知识点2"]
    }
  ]
}
```

### A.12 变式题校验（variation/validate.md，P1 实现）

```markdown
## System Prompt

你是一位数学题目审核专家，请检查以下变式题的质量。

### 检查维度
1. **逻辑自洽**：题目条件是否矛盾？方程是否有实数解？
2. **答案正确**：标注的答案是否真正吻合题干？
3. **难度匹配**：目标难度 {{targetDifficulty}}，实际难度是否接近？
4. **知识点覆盖**：是否真正考察了目标知识点？

### 输出格式
严格输出 JSON：
{
  "valid": true/false,
  "issues": ["问题描述（若 valid=false，说明具体哪里不对）"],
  "difficultyMatch": true/false,
  "knowledgePointMatch": true/false
}
```

### A.13 内容分类器（safety/classifier.md）

已在 §5.8.1 中完整给出。

### A.14 温和阻断话术库（safety/gentle-block.md）

已在 §5.8.2 中完整给出（YAML 格式）。

### A.15 兜底完整解析（fallback/full-explanation.md）

已在 §5.8.3 中给出完整 System 和 User 模板。

### A.16 学情报告生成（analytics/report.md）

```markdown
## System Prompt

你是一位专业的教育顾问，需要为家长生成一份学生学习报告。

### 要求
1. **鼓励为主**：先肯定进步，再指出不足
2. **数据说话**：引用具体的数字（时长、正确率、排名变化）
3. **可操作**：建议要具体，家长看了知道怎么做
4. **不要吓唬**：即使数据不好，也要用积极的语言表达

### 输出格式
严格输出 JSON：
{
  "reportTitle": "报告标题",
  "summary": "总体评价（2-3句，积极正向）",
  "highlights": [
    { "icon": "star"|"trending_up"|"warning"|"target", "title": "亮点", "description": "描述" }
  ],
  "weakPointAnalysis": "薄弱点分析文本（3-5句，含具体知识点名称）",
  "suggestions": ["给家长的具体建议1", "建议2"],
  "encouragement": "给学生的鼓励语"
}
```

### A.17 错题解析生成（explanation/error-analysis.md）

```markdown
## System Prompt

你是一位耐心的辅导老师，需要为学生生成错题的详细解析。

### 输出结构
1. **错因分析**：学生为什么会做错？（概念不清 / 计算粗心 / 审题不准）
2. **分步解析**：逐步展示正确解法
3. **知识点链接**：这道题用到了哪些知识点
4. **避坑提醒**：这个知识点最常见的错误是什么

### 语气
温和鼓励，不要让学生感到沮丧。用"我们"而不是"你"。

---

## User Message
**题目**：{{question.content}}
**你的答案**：{{wrongAnswer}}
**标准答案**：{{question.answer}}

请帮我分析错因并给出正确解法。
```

### A.18 知识点重讲（explanation/knowledge-retry.md）

```markdown
## System Prompt

学生反复在某个知识点上出错，需要你重新讲解这个知识点。

### 输出结构
1. **为什么重要**：这个知识点在整个学科中的位置（1-2句）
2. **重新讲解**：用最通俗的方式重新讲一遍（用类比、例子）
3. **常见误区**：列 2-3 个学生最容易犯的错误
4. **自测问题**：出 1 道简单题让学生当场试试

### 注意
- 不要重复之前的讲解方式，换一个角度
- 如果之前用的是抽象公式，这次用具体例子
- 如果之前用的是文字，这次用图表/公式

---

## User Message
**知识点**：{{knowledgePoint.name}}
**学生错误记录**：
{{#errorHistory}}
- 题目：{{question}}，错误答案：{{wrongAnswer}}（第{{attempts}}次尝试）
{{/errorHistory}}
```

---

## 附录 B：接口 DTO 定义

本附录汇总全文所有 TypeScript 接口和枚举的完整定义，按层级索引。

### B.1 infra 层类型

**ModelRouter**：
```typescript
// 见 §3.1.2 RouteRequest / RouteResult / ModelConfig
```

**PromptBuilder**：
```typescript
// 见 §3.2.3 PromptBuildRequest / PromptContext / PromptBuildResult / ChatMessage
```

**ModelClient**：
```typescript
// 见 §3.3.3 ChatRequest / ChatResponse / StreamChunk
// 见 §3.3.4 错误体系(LLMClientError 及子类) / §3.3.5 重试策略(RetryOptions)
```

**SafetyGuard**：
```typescript
// 见 §3.4.3 SafetyCheckRequest / SafetyCheckResult / SafetyAlert
```

**ResponseParser**：
```typescript
// 见 §3.5.3 ParseRequest / ParseResult / ParseMode
// 见 §3.5.4 GradingResult / StepGrade
```

**FallbackHandler**：
```typescript
// 见 §3.6.3 FallbackRequest / FallbackResponse
```

### B.2 capabilities 层类型

**TutoringCapability**：
```typescript
// 见 §4.1.4 TutoringRequest / TutoringResponse
```

**GradingCapability**：
```typescript
// 见 §4.2.3 GradingRequest
// GradingResponse = GradingResult（见 §3.5.4）
```

**VariationCapability**：
```typescript
// 见 §4.4.4 VariationRequest / VariationResponse / VariationQuestion
```

**AnalyticsCapability**：
```typescript
// 见 §4.5.2 AnalyticsRequest （输入统计由 ParentAdmin 提供）
// 见 §4.5.3 AnalyticsResponse
```

### B.3 外部服务协议类型

**ConversationService**：
```typescript
// 见 §6.1.2
// LoadContextRequest / LoadContextResponse / SaveMessagesRequest
// UpdateFailCountRequest / CompleteDialogueRequest
```

---

## 附录 C：配置项清单

### C.1 模型路由配置（model-routes.yaml）

```yaml
# 模型连接配置
models:
  kimi:
    provider: kimi
    modelId: kimi-latest
    baseUrl: ${KIMI_BASE_URL}
    apiKey: ${KIMI_API_KEY}
    contextWindow: 131072
    maxOutputTokens: 16384
    costPer1K:
      input: 0.012
      output: 0.012
    supportsStreaming: true
    features: [chat, reasoning]

  qwen3.8-max:
    provider: qwen
    modelId: qwen3.8-max
    baseUrl: ${QWEN_BASE_URL}
    apiKey: ${QWEN_API_KEY}
    contextWindow: 131072
    maxOutputTokens: 32768
    costPer1K:
      input: 0.007
      output: 0.028
    supportsStreaming: true
    features: [chat, reasoning, json_mode]

  gemini-3.1-pro:
    provider: gemini
    modelId: gemini-3.1-pro
    baseUrl: ${GEMINI_BASE_URL}
    apiKey: ${GEMINI_API_KEY}
    contextWindow: 1048576
    maxOutputTokens: 65536
    costPer1K:
      input: 0.0025
      output: 0.01
    supportsStreaming: true
    features: [chat, reasoning, long_context]

  deepseek-flash:
    provider: deepseek
    modelId: deepseek-flash
    baseUrl: ${DEEPSEEK_BASE_URL}
    apiKey: ${DEEPSEEK_API_KEY}
    contextWindow: 131072
    maxOutputTokens: 65536
    costPer1K:
      input: 0.001
      output: 0.004
    supportsStreaming: true
    features: [chat, fast, cheap]

# 路由规则
routes:
  tutoring:
    - subject: math
      difficulty: [1, 2]
      primary: qwen3.8-max
      fallback: deepseek-flash
    - subject: math
      difficulty: [3]
      primary: gemini-3.1-pro
      fallback: qwen3.8-max
    - subject: chinese
      primary: kimi
      fallback: deepseek-flash
    - subject: english
      primary: kimi
      fallback: qwen3.8-max

  grading:
    - subject: math
      primary: qwen3.8-max
      fallback: kimi
    - subject: chinese
      primary: kimi
      fallback: qwen3.8-max
    - subject: english
      primary: kimi
      fallback: qwen3.8-max

  explanation:
    - subject: math
      primary: qwen3.8-max
      fallback: deepseek-flash
    - subject: chinese
      primary: kimi
      fallback: qwen3.8-max
    - subject: english
      primary: kimi
      fallback: qwen3.8-max

  variation:
    - subject: math
      primary: qwen3.8-max
      fallback: gemini-3.1-pro

  analysis:
    - subject: "*"
      primary: kimi
      fallback: qwen3.8-max

  safety:
    - subject: "*"
      primary: deepseek-flash
      fallback: ~   # 无备选，这是最简单的分类任务

# 默认模型（路由表未匹配时使用）
default:
  primary: qwen3.8-max
  fallback: deepseek-flash
```

### C.2 重试与超时配置（retry.yaml）

```yaml
retry:
  maxRetries: 2
  baseDelayMs: 1000
  maxBackoffMs: 60000

timeout:                      # 非流式 per-scene 请求超时（provider.chat / gemini 走这条）
  default: 45000
  tutoring: 45000
  grading: 45000
  judgment: 90000
  explanation: 120000
  variation: 60000
  hint: 45000
  safety: 10000
  structuring: 45000

streaming:                    # OpenAI 兼容流式的「空闲超时」（收到数据即重置）
  firstTokenTimeoutMs: 3000   # 首字节到达前允许的等待
  interTokenTimeoutMs: 10000  # 收到首字节后，两次数据间的最大间隔
```

**超时语义（2026-09-11 起）**：`ModelClient.chat` 默认流式（聚合 `provider.streamChat`），`streamChat` 用的是 `streaming.*` 的**空闲超时**——每收到一块数据就把倒计时重置，**不是从请求开始算的墙钟硬超时**（早前用 `AbortSignal.timeout(per-scene)`，会把 reasoner（qwen3.8-max）难题的长时间思考在 45s 处拦腰砍断）。空闲超时抛 `TimeoutError`(statusCode 408)，`mapLLMErrorToClient` 映射为「AI 响应超时」；用户主动停止（外部 `AbortSignal`）仍走 `AbortError` 语义、不报错兜底。`timeout.*` 仍是各非流式调用（`provider.chat`、gemini 非流式降级）的硬超时。

### C.3 安全检测配置（safety.yaml）

```yaml
safety:
  classifier:
    model: deepseek-flash
    confidenceThreshold: 0.7   # 低于此置信度视为 learning（宁可漏判不误杀）
    
  off_topic:
    escalateThreshold: 3       # 连续 N 次闲聊升级到 warning
    criticalThreshold: 5       # 连续 N 次闲聊升级到 critical

  anomaly:
    types:
      emotional:
        alertLevel: warning
        block: true
      sensitive:
        alertLevel: critical
        block: true
      abusive:
        alertLevel: critical
        block: true

  gentleBlock:
    randomPick: true           # 随机选择话术（避免重复感）
```

### C.4 兜底配置（fallback.yaml）

```yaml
fallback:
  consecutiveFailThreshold: 3  # 连续 N 次失败触发
  giveUpKeywords:
    - 不会
    - 不懂
    - 不知道
    - 太难
    - 放弃
    - 算不出来
    - 想不出来
    - 怎么做
    - 完全不会
  outputStructure:
    - 温和开场
    - 分步解析
    - 知识点总结
    - 学习建议
```

### C.5 额度控制配置（quota.yaml）

```yaml
quota:
  redisKeyPrefix: "quota"
  resetCron: "0 0 1 * *"      # 每月 1 号 00:00 重置
  
  thresholds:
    warning80: 0.8
    warning95: 0.95
    exhausted: 1.0

  degradedService:
    tutoring: hint_only        # 仅提示，不深度讨论
    grading: objective_only    # 仅客观题
    variation: disabled
    analytics: numeric_only    # 仅数字不生成文本
```

### C.6 日志与监控配置（observability.yaml）

```yaml
logging:
  format: json
  level: info
  includeTraceId: true

metrics:
  prometheus:
    enabled: true
    port: 9090
    prefix: ai_agent_

quality:
  regressionTest:
    enabled: true
    cron: "0 8 * * 1"         # 每周一 8:00
    gradingTestSetSize: 30
    tutoringTestSetSize: 20
    variationTestSetSize: 50
    safetyTestSetSize: 100

alerts:
  gradingAccuracyDrop: 0.05   # 准确率下降 5% 告警
  tutoringQualityDropDays: 7  # 连续 7 天下降告警
  variationRejectRate: 0.30   # 变式拒收率 > 30% 告警
```

---

> **文档结束**。本文档与架构文档 §4.2.1 保持一致。如有变更，请同步更新两份文档。
