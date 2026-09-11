# qwen3.8-max 改名 + 多模态替代 VL + 去掉两阶段图片流程

- 日期：2026-09-11
- 状态：设计已与用户逐节确认
- 关联文档：`CLAUDE.md`（ai-core 场景路由段、模型 ID 列表）、`docs/ai-core-changelog.md`、`docs/superpowers/specs/2026-09-11-local-judging-model-design.md`（前序分支，已合并）、`docs/K12智学系统-AI-Agent中枢设计文档.md` §4.4.2

## 1. 背景与问题

1. 项目现用 `qwen3.7-max` 作为 tutoring / explanation / default 等场景主模型；用户要求全局换成 **`qwen3.8-max`**。
2. `qwen3.8-max` **支持多模态**（2026-09-11 实测：OpenAI 兼容模式下 `image_url` 部件可用并正确描述图片）。因此 `qwen-vl-max` / `qwen3-vl-plus` 两个 VL 模型与 `transcribe` 场景不再必要——文本与图片一起送给 `qwen3.8-max` 即可。
3. 现图片链路是**两阶段**：`ai.service` 在 `idle + 有图` 时短路进 `transcribeStage`（VL 模型转录 → 前端确认/多题选择 → 再辅导）。既然主模型本身多模态，这套两阶段（含前端「确认这道题」UI、`flow_state` 状态机、多题选择）成为多余复杂度。
4. 探明（Explore）：**直送多模态在机制上已通**——`ContentPart`/`ImagePart`、`Attachment.imageUrl`（base64）、流式序列化都现成，`POST /ai/tutor` 现在就是直送；挡住图片直送的只有 `ai.service` 的 `transcribeStage` 短路分支。`prompts/tutoring/math/auxiliary.md` 已有「图片输入处理」（转录题干、多题用编号列表）与「多题处理」段，直送后可直接复用。

实测事实（2026-09-11）：
- `qwen3.8-max` 存在；兼容模式 `image_url` 多模态可用；
- `qwen3.8-max` 默认带 `reasoning_content`（thinking ON）；`enable_thinking: false` 生效（completion 20→1 token）；
- 本地 llama.cpp 忽略 `enable_thinking`（要关得用 `chat_template_kwargs`，见 §6 非目标）。

## 2. 目标与非目标

**目标**

1. `qwen3.7-max` → `qwen3.8-max`（YAML 模型定义 + 所有路由引用 + `default`），含 DB 与部署脚本；
2. 删除 `qwen-vl-max` / `qwen3-vl-plus` 模型与 `transcribe` 场景，图片+文本直送 `qwen3.8-max`；
3. 删除两阶段图片流程（后端状态机 + 前端确认/多题选择 UI），一图多题交给 prompt；
4. 判题（`judgment`）**所有模型调用不带 thinking**，以请求级开关实现（见 §3.2）；
5. `judgment` 路由 fallback 改为 `qwen3.8-max`（统一运行时回退与新装降级目标）。

**非目标**

- **不动** `ai_dialogues.flow_state` / `pending_question` / `pending_questions` 三列结构（保留为死数据，仅一次性重置 `awaiting_*` → `idle`）；不做破坏性迁移；
- **不为本地 llama.cpp 关 thinking**（需 `chat_template_kwargs: {enable_thinking:false}`，且关掉后输出被 ```json 围栏包裹，需另验 `ResponseParser`；且可能影响判题准确性）——另议；
- 不改 `judgment` 的 primary=`local`；不改本地模型与其 upsert 脚本语义；
- 不新增 `qwen3.8-max-nothink` 模型条目（改用请求级 `thinking` 开关，理由见 §3.2）；
- 不改 `SaveMessageEntry.type='transcription'`——那是训练「讲一讲」的题面锚消息，与图片流程无关；
- 不引入新环境变量（VL 复用 `QWEN_BASE_URL`/`QWEN_API_KEY`）。

## 3. 总体设计

### 3.1 配置层（`apps/server/src/ai-core/model-routes.yaml`）

- 模型定义 `qwen3.7-max` 块（key `15`、`modelId` `17`）改名为 `qwen3.8-max`（key 与 modelId 同为 `qwen3.8-max`）；
- 所有路由中的 `qwen3.7-max` → `qwen3.8-max`（tutoring `104/109/115`、grading `119 注释/122/125/128`、explanation `139/143/146`、hint `152`、variation `156`、analysis `162`、structuring `171`），`default.primary`（`174`）→ `qwen3.8-max`；
- 删除 `qwen-vl-max` 块（`65–77`）、`qwen3-vl-plus` 块（`79–91`）、`transcribe` 路由（`95–100`）；
- `judgment` 路由：`primary: local`，`fallback` 由 `deepseek-v4-flash` 改为 `qwen3.8-max`；
- `retry.yaml`：删 `transcribe: 60000` 行。

### 3.2 thinking：请求级开关（不使用第二个模型条目）

**为什么不用 `qwen3.8-max-nothink` 条目**：DB 是运行时真源，第二个模型条目需要给 `llm_models` 加 `thinking` 列并打通 repo / registry / admin 服务 / controller / 前端表单 / seed——为一个开关不值。

**做法**：

- `ai-core/types.ts` 的 `ChatRequest` 增可选 `thinking?: boolean`；
- `OpenAICompatibleClient.buildRequestBody`：把硬编码的 `body.enable_thinking = true` 改为 `body.enable_thinking = request.thinking !== false`（不传 = true，其它场景行为不变）；
- `JudgmentCapability.callModel` 的 `modelClient.chat({...})` 传 `thinking: false`（primary 与 fallback 两次调用都传）；
- `LocalClient.buildRequestBody` 仍 `delete body.enable_thinking`（llama.cpp 忽略该字段，保留表达意图）。

**效果**：判题无论走本地（无影响）、还是走 `qwen3.8-max`（无论是运行时 fallback 还是新装降级后被 seed 提升为 primary），都不带 thinking。判题是轻量任务，符合项目此前「判题用快模型」的取向。

### 3.3 后端图片链路：删除两阶段

- `capabilities/tutoring.capability.ts`：删 `transcribeImage()`（`208–233`）、`classifySelection()`（`237–256`）、`parseTranscribeResult()`（`280–295`）；保留 `augmentWithImages()`（`258–278`，直送图片用它）与 `prepare()` 中的图片增强（`464–483`）；清理顶部对 `TranscribeResult`/`TranscribedProblem`/`SelectionClassification` 的 import；
- `modules/ai/ai.service.ts`：删 `transcribeStage()`（`120–156`）、`selectionStage()`（`158–186`）、`correctStage()`（`188–198`）与 `handleStream` 中的 flow 分支（`89/92–113`）——`idle + 图片` 直接走 `tutorStage()`；删所有 `updateFlowState` 调用；`validateDto()`（`219–232`）去掉「允许空 message 当带 flowAction」的条件（带 attachments 仍允许）；`buildRequest`（`384`）去掉 `flowAction`；
- `modules/ai/dto/tutor.dto.ts`：删 `flowAction`（`17`）；
- `ai-core/types.ts`：删 `Scene`/`CapabilityType` 中的 `'transcribe'`（`15`/`51`）；删 `TranscribeResult`、`TranscribedProblem`（`166–180`）；删 `StreamEvent` 的 flow 字段（`type:'flow'`、`stage`/`problems`/`question`，`156/165–167`）；删 `TutoringRequest.flowAction`（`411`）；删 `LoadContextResponse.flowState`/`pendingQuestion`/`pendingQuestions`（`577–579`）；`RouteRequest.hasImage` 注释更新（该字段仍被 safety-guard 使用，路由早已忽略）；
- `infra/prompt-builder.ts`：删 `capability === 'transcribe'` 分支（`96–98`）；
- 删 `apps/server/src/ai-core/prompts/transcribe/math.md`（整个 `transcribe/` 目录）；
  - ⚠️ `prompt-builder.resolveTemplatePath`（`99`）对未知 capability 直接抛错——`Scene`/`CapabilityType` 去掉 `'transcribe'`、`prompt-builder` 去掉分支、删 prompt 文件**三者必须同一步完成**，否则中间状态运行即抛错。
- `modules/admin/admin-models.service.ts`：`SCENES`（`8`）去 `'transcribe'`（后台场景下拉随之少一项）；
- `services/conversation/index.ts`：删 `updateFlowState()`（`162–172`）与 load 时的 flow 字段（`114–116`）；`database/repositories/ai-dialogues.repo.ts`：删 `updateFlowState()`（`129–141`）；`repositories/types.ts` 的 `flow_state` 字段**保留**（它忠实镜像仍在的 DB 列，删了反而要改 `mapRow`），DB 列保留为死数据。

> 一图多题：交给 `prompts/tutoring/math/auxiliary.md` 既有的「图片输入处理 / 多题处理」段，无需改 prompt。

### 3.4 前端：去掉 flow 交互

- `store/chatStore.ts`：删 `ChatFlow`（`10–16`）、`ChatError.stage`（`7`）、`ChatMessage.flow`（`27`）、`setLastAssistantFlow()`（`108–118`）及其类型；
- `hooks/useAuxChat.ts`：删本地 `StreamEvent` 的 flow 字段（`19–30`）、`streamTutor` 的 `flowAction` 参数与请求体字段（`105/122`）、flow 事件处理（`161–172`）、`send()` 中「确认态打字=纠正」（`254–258`）与用户气泡「确认/重新识别」标签（`281–285`）、`confirmQuestion`/`reidentify`（`306–308`）；
- `components/business/AuxChatPanel.tsx`：删 `onConfirm`/`onReidentify` props（`13–14`）与确认/选择 UI（`366–392`）；
- `pages/student/AuxiliaryHomePage.tsx`：去掉对 `confirmQuestion`/`reidentify` 的解构与 `onConfirm`/`onReidentify` 传参（`42/98`）；
- 图片附件发送与气泡渲染不变（`AuxInputBar.tsx:275–289`、`AuxChatPanel.tsx:348–360`）。

### 3.5 DB 迁移 / 部署 / 文档

**新增幂等脚本** `apps/server/src/scripts/migrate-qwen38-multimodal.ts`（运行：`cd apps/server && npx tsx src/scripts/migrate-qwen38-multimodal.ts`；生效需重启后端或后台保存路由触发 `registry.reload()`）：

1. upsert `qwen3.8-max` 模型行（`provider_type='qwen'`、`model_id='qwen3.8-max'`、`base_url` 取 `QWEN_BASE_URL`、`api_key` 经 `encryptApiKey`；`context_window`/`max_output_tokens` 取 YAML `models['qwen3.8-max']`）；**必须先于路由改名**（primary FK 指向 `llm_models.model_key`）；
2. `UPDATE llm_routes SET primary_model_key='qwen3.8-max' WHERE primary_model_key='qwen3.7-max'`，fallback 同；再把 `judgment/math` 设为 `primary='local', fallback='qwen3.8-max'`；
3. `DELETE FROM llm_routes WHERE scene='transcribe'`；
4. `DELETE FROM llm_models WHERE model_key IN ('qwen3-vl-plus','qwen-vl-max','qwen3.7-max')`（在第 1–3 步之后，确保无 primary 引用；`fallback_model_key` 无 FK 但仍先改）；
5. `UPDATE ai_dialogues SET flow_state='idle', pending_question=NULL, pending_questions=NULL WHERE flow_state <> 'idle'`（best-effort）；列结构不动。

**部署脚本**：`tools/deploy/apply-llm-config.mjs:22` 的 `qwen: 'qwen3.7-max'` → `'qwen3.8-max'`；`tools/deploy.sh:315` 的 `def_model='qwen3.7-max'` → `'qwen3.8-max'`。

**文档同步**：
- `CLAUDE.md`：模型 ID 列表 `qwen3.7-max` → `qwen3.8-max`；ai-core 场景路由段删 `transcribe`/VL 描述、图片改为「直送多模态」；判题段补「judgment 调用不带 thinking」；`qwen3.8-max` 多模态与「图片两阶段已删除」写入关键约定；
- `docs/ai-core-changelog.md`：新增 2026-09-11 条目（本条，与 local-judging 条目分列）；
- `docs/K12智学系统-AI-Agent中枢设计文档.md`：§4.4.2「两阶段设计」改为「直送多模态」；全文 `qwen3.7-max`→`qwen3.8-max`、删除 VL 模型相关描述；
- `docs/K12智学系统-数据库设计文档.md`：`qwen3.7-max` 示例改 `qwen3.8-max`（`flow_state` 列保留，标注「已弃用/死数据」）；
- `docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml`：**已核实不含 flowAction/flow_state/transcribe**，无需改；`dist/` 靠 `npm run build` 重建。

### 3.6 测试

- 更新 `apps/server/src/ai-core/infra/model-router.test.ts`：tutoring 断言 `qwen3.8-max`；删 `transcribe` 用例（`67–71`）与 VL 相关断言（`62–65/73–76`，改为不断言不存在模型）；judgment 断言 fallback `qwen3.8-max`；
- 更新 `apps/server/src/ai-core/infra/model-router-dynamic.test.ts`（`8/15`）→ `qwen3.8-max`；
- 更新 `apps/server/src/ai-core/capabilities/tutoring.capability.test.ts`：删 transcribe/selection 相关用例；保留「图片以 `image_url` 部件送达辅导模型」（`205–233`）并改 mock 模型名为 `qwen3.8-max`；
- 新增 `openai-compatible-client.test.ts` 用例：`thinking: false` → 请求体 `enable_thinking === false`；不传 → `true`；
- 新增 `judgment.capability.test.ts` 断言：judgment 两次 `chat` 调用均带 `thinking: false`；
- 其余测试中把 mock 字符串 `qwen3.7-max`/`qwen-vl-max` 更新为 `qwen3.8-max` 只是标签，不影响断言。

## 4. 关键决策与取舍

| 决策 | 选择 | 理由 |
|---|---|---|
| 改名范围 | 全局（模型定义 + 所有路由 + default + DB + deploy） | `qwen3.8-max` 全面替代 `qwen3.7-max` |
| 多模态 | 删 VL 模型与 `transcribe`，图片直送主模型 | 主模型本身多模态，省一模型与一阶段 |
| 两阶段 | 彻底删除（后端状态机 + 前端确认/多题 UI） | 用户明确选择；直送机制已通，多题交给 prompt |
| 一图多题 | 交给 `auxiliary.md` | 该 prompt 已有编号转录/多题处理段，够用 |
| thinking | 请求级 `ChatRequest.thinking`，仅 judgment 传 false | 避免为单开关加 DB 列 + 后台字段 + 全链路（YAGNI） |
| 判题 fallback | 统一为 `qwen3.8-max`（运行时 + 新装降级） | 一个目标、机制简单；无 thinking 保证速度 |
| `flow_state` 列 | 保留为死数据，只重置值 | 避免破坏性迁移；无其它读者 |
| DB 落地 | YAML + 幂等迁移脚本 | DB 是运行时真源，seed 是 skip-if-exists |

## 5. 影响文件清单

**新增**
- `apps/server/src/scripts/migrate-qwen38-multimodal.ts`

**删除**
- `apps/server/src/ai-core/prompts/transcribe/math.md`（整个目录）

**修改（后端）**
- `apps/server/src/ai-core/model-routes.yaml`、`retry.yaml`
- `apps/server/src/ai-core/types.ts`
- `apps/server/src/ai-core/infra/model-client/openai-compatible-client.ts`（thinking 开关）
- `apps/server/src/ai-core/infra/prompt-builder.ts`
- `apps/server/src/ai-core/capabilities/tutoring.capability.ts`、`judgment.capability.ts`
- `apps/server/src/modules/ai/ai.service.ts`、`dto/tutor.dto.ts`
- `apps/server/src/modules/admin/admin-models.service.ts`（SCENES）
- `apps/server/src/services/conversation/index.ts`
- `apps/server/src/database/repositories/ai-dialogues.repo.ts`（`types.ts` 的 `flow_state` 字段保留以镜像 DB 列，不改）
- 测试：`model-router.test.ts`、`model-router-dynamic.test.ts`、`tutoring.capability.test.ts`、`judgment.capability.test.ts`、`openai-compatible-client.test.ts`、其余 mock 标签

**修改（前端）**
- `apps/web/src/store/chatStore.ts`
- `apps/web/src/hooks/useAuxChat.ts`
- `apps/web/src/components/business/AuxChatPanel.tsx`
- `apps/web/src/pages/student/AuxiliaryHomePage.tsx`

**修改（脚本 / 文档）**
- `tools/deploy/apply-llm-config.mjs`、`tools/deploy.sh`
- `CLAUDE.md`、`docs/ai-core-changelog.md`、`docs/K12智学系统-AI-Agent中枢设计文档.md`、`docs/K12智学系统-数据库设计文档.md`

## 6. 测试与验收

**自动化**：`cd apps/server && npm test`（当前 418）+ `npm run build` 全绿；`cd apps/web && npm run build && npm run lint` 通过。

**手动验收（需 Qwen 可用）**：
1. 跑迁移脚本 → 查 DB：`qwen3.8-max` 存在、无 `qwen3.7-max`/VL 行、无 `transcribe` 路由、`judgment/math = local / qwen3.8-max`；
2. 辅线传一张题图 → 直接进入辅导（**不再出现**「确认这道题」步骤），模型正确读图并辅导；
3. 一图多题 → 模型按编号列出并询问从哪题开始；
4. 训练判题（一道 fill_blank 不等价）→ 正常返回；本地在线走本地、本地不可用回退 `qwen3.8-max` 且日志/耗时符合预期（无 thinking）。

## 7. 风险与待验证

1. **迁移脚本对已 seed 库的破坏性**：删模型行受 primary FK 约束，顺序必须是「先插新模型 → 改路由 → 删 transcribe 路由 → 删旧模型」。脚本须幂等且带打印摘要；建议先在备份库/开发库跑。
2. **两阶段删除的 UX 回归**：学生失去「识别对不对」的确认与多题显式选择；靠多模态识别质量与 prompt 兜底。若实测识别/多题体验差，需回补轻量确认（本次不做）。
3. **`ChatRequest.thinking` 覆盖面**：只有 `buildRequestBody` 一条路径（chat/streamChat 共用），流式同样生效；须有单测钉住。
4. **判题无 thinking 的质量**：`enable_thinking:false` 实测 JSON 仍合规（1 token 出 `2`），但复杂判题的准确性未评测；若下降明显，回退为仅降级/回退目标关 thinking（改一处判断）。
5. **本地 thinking 未关**：本地判题仍带 thinking（llama.cpp 忽略 `enable_thinking`），延迟偏高；留待单独任务用 `chat_template_kwargs` 处理并验证围栏解析。
6. **文档面广**：多份设计文档引用旧模型/两阶段，按 doc-sync 规则逐一更新，避免留下矛盾描述。
