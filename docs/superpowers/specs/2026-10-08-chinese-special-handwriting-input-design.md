# 语文专项手写输入 — 设计文档

日期：2026-10-08
状态：已与用户逐节确认（方案 A）
前置调研：`docs/superpowers/specs/2026-10-08-handwriting-recognition-demo-design.md`（识别率已验证：本地模型可用，qwen3.8-max 更高，暂用本地）

## 1. 背景与目标

语文专项两个作答页（古诗文默写、古诗文解释）目前只支持键盘/输入法输入。本设计给每个输入框增加「手写」入口：手写面板写字 → 后端大模型识图转文本 → 学生在弹层内校对 → 确认后回填输入框。**提交后的判题、积分、错误流全部不变**——手写只改变「字怎么进输入框」。

用户已确认的四个口径：

| 决策点 | 结论 |
|---|---|
| 手写入口粒度 | 每个输入框一个「手写」按钮（不做全局模式开关） |
| 长文处理 | 分批识别追加：面板写几行→识别→续到校对区，可多批，最后统一校对 |
| 校对形态 | 弹层内可编辑校对区，点「确认填入」才回填原输入框 |
| 端点归属 | ai 模块通用端点 `POST /api/ai/handwriting/transcribe`（学生角色），模型走 DB 路由 |

模型策略：**先用本地模型**（llama.cpp，已实测识别率可用）；将来切 qwen3.8-max 只改 DB `llm-routes` 一条记录，零发版。

## 2. 非目标（有意不做）

- 不动判题端点/判题逻辑/积分/错题流（手写只是文本进入输入框的另一种方式）
- 不做全局「手写模式」开关、不做数学/英语接入（本次只语文专项两页）
- 识别结果不落库（只有 LLM 账本/埋点自动记录）
- 不做手写公式识别（PRD §15 远期，另行立项）
- 不新增埋点

## 3. 总体数据流

```
输入框旁「手写」按钮 → HandwritingInputModal 弹层
  ① 手写面板写几行 → 点「识别并追加」
  ② POST /api/ai/handwriting/transcribe { image }   ← 学生角色
  ③ ModelRouter.route(scene 'handwriting', subject 'chinese') → 本地模型（DB 路由配置）
  ④ 识别文本追加到弹层内校对区（可编辑，批间自动补换行）
  ⑤ 面板清空，可继续写下一批 → 重复①-④
  ⑥ 点「确认填入」→ 校对区全文回填该输入框，弹层关
  ⑦ 之后与键盘输入完全一致：提交 → 判题 → 积分/错题流不变
```

## 4. 前端设计（apps/web/src/components/business/）

### 4.1 HandwritingPad（由 DemoSketchPad 泛化提升）

- 文件：`HandwritingPad.tsx`；demo 页改用它，`pages/dev/DemoSketchPad.tsx` 删除（避免双份漂移）。
- 逻辑不变：720×360 逻辑 px、dpr 一次缩放、lineWidth 3、笔/橡皮/清空、二次贝塞尔平滑、ref 句柄 `{ exportImage(): string | null; clear(): void }`、`onStrokesChange?: (count: number) => void`。
- 两处调整：
  1. **屏显笔迹颜色随主题**：语文专项页是学习沉浸页（18:00 后自动切夜间），写死深色夜间看不清。重绘时读主题 CSS 变量（同 DraftWhiteboard 的做法，不存色值）。
  2. **导出恒白底黑字**（#FFFFFF 底 + #111827 笔迹，scale 2）：识别最稳，不随主题。

### 4.2 HandwritingInputModal（弹层组件）

- props：`{ open: boolean; title: string; onConfirm(value: string): void; onClose(): void }`。
- 结构：顶部标题 + HandwritingPad + 工具行（「识别并追加」「重试」）+ 可编辑校对区（textarea）+ 底部「确认填入」。
- 状态机：

```
idle → recognizing → idle（追加成功，面板已清空）
                   → error（红字错误 + 「重试」，面板笔迹保留）
「识别并追加」禁用 = 面板无笔画 || recognizing
「确认填入」禁用   = 校对区为空 || recognizing
```

- 追加规则：每次识别结果追加前，若校对区已有内容且结尾不是 `\n`，先补一个 `\n` 再追加（批间分隔，学生可自行删改）。
- **弹层关闭不卸载**（open 控制显隐，组件随宿主字段常驻）：误关后笔迹与校对区都保留；只有「确认填入」（回填 + 关 + 清空面板与校对区）或「清空」才清。
- 换题（默写换篇 / 解释换句）时宿主组件重挂载，手写内容自然清空——与草稿「随题存在」语义（PRD §7.12）一致。

### 4.3 接入点（每字段一个「手写」小按钮）

| 页面 | 文件 | 手写入口 |
|---|---|---|
| 古诗文默写 | `DictationAnswerForm.tsx` | 作者 input、朝代 input、正文 textarea（3 处） |
| 古诗文解释 | `SentenceBlock.tsx` | 每个词的 input + 整句翻译 textarea |

- 按钮为小号文字按钮「手写」，置于输入框旁，样式用现有 token（对齐所在页面既有按钮）。
- onConfirm 直接 `setValue(value)` 回填对应字段（受控输入，回填后学生仍可在原输入框继续编辑）。

## 5. 后端设计（apps/server）

### 5.1 端点 POST /api/ai/handwriting/transcribe

- 挂 `AIController`（`modules/ai/ai.controller.ts`）新方法，类级 `@Roles('student')` 继承；转写逻辑放 ai 模块新 `handwriting.service.ts`（模板 = `modules/dev/dev-handwriting.service.ts`）。
- 请求 body：`{ image: string }`（**无 modelKey**——模型由路由决定）。
- 校验（顺序执行）：`image` 匹配 `^data:image/(png|jpeg);base64,` → 400/4001；base64 解码 ≤4MB → 400/4002。
- 路由：`ModelRouter.route({ scene: 'handwriting', subject: 'chinese' })` 取 primary/fallback（带账本打标与 fallback）。
- system prompt：沿用调研版——`你是 OCR 引擎。把图片中的手写汉字逐字转写为简体中文纯文本，只输出转写结果本身，不要输出任何解释或多余符号。无法辨认的字输出最接近的猜测。`
- 与 dev 端点的三处不同：
  1. 走 `ModelRouter`（不再是前端指定 modelKey）；
  2. `meta: { capability: 'handwriting_transcribe' }` **不带 studentId**——学生真实请求由 ALS 上下文归属（token 用量计入学生）；dev 版显式 null 不适用；
  3. `thinking: false`（转写要快；本地模型忽略该参数无碍）。
- timeout：`timeoutConfig.timeout.default`；实测本地识别偏慢再调。
- 返回：`{ text, modelKey, elapsedMs }`（text trim）。
- 错误：上游模型失败 → 502/5502 简化错误信息。

### 5.2 scene 'handwriting' 与模型路由配置

- ai-core `types.ts` 的 `Scene` union 加 `'handwriting'`（连带 `CapabilityType` 不动——本能力不建 capability 类，service 直调 ModelClient）。
- `apps/server/src/ai-core/model-routes.yaml` 加 handwriting 场景：`chinese` → primary 本地模型 key（与 judge/错因场景同一 local 条目），fallback 可空。
- DB `llm_routes` 加同款记录：迁移 SQL 放 `tools/db/migrations/2026-10-08_handwriting_scene.sql`，**幂等**（INSERT ... WHERE NOT EXISTS 或等价写法）；schema.sql 无新表/列则不动。
- admin 模型配置页如有 scene 枚举校验/下拉，同步加 `'handwriting'`（实施时 grep scene 枚举引用点逐一处理）。
- **切云端**：改 DB `llm_routes` 里 handwriting 行的 primary_model_key 指向 qwen3.8-max 条目即可，零发版。

## 6. 错误处理与边界

- 识别失败：弹层内红字 + 可重试，面板笔迹保留。
- 图片不合法（前缀/超限）：400，弹层显示错误信息，笔迹保留。
- 弹层未确认关闭：内容保留在弹层（不回填、不丢失）；「确认填入」是唯一回填路径。
- 不留档：识别结果仅前端内存；LLM 调用经既有账本/埋点记录，无新增表。
- 长文上限：受输入框/判题端点既有约束约束，本设计不加新限制；校对区为普通 textarea，无字数硬限。

## 7. 测试

- **HandwritingPad**：迁移 DemoSketchPad 现有 3 用例（渲染+挂载通知 / 导出 / 橡皮整条擦除）。
- **HandwritingInputModal**（mock transcribe API）：追加拼接与自动换行分隔；「确认填入」回填 onConfirm 参数；识别失败 → 错误显示 + 重试成功；禁用态（无笔画/校对区空/识别中）；关弹层重开内容保留。`afterEach(cleanup)` 照仓规。
- **接入点渲染测试**：DictationAnswerForm / SentenceBlock——手写按钮存在；mock HandwritingInputModal 确认后值回填到对应字段。
- **后端**：`handwriting.service` 单测（校验 4001/4002、router 调用参数 scene/subject、上游失败 502、meta 断言）；AIController 守卫断言（学生过/家长 403/未登录 401，同 points.controller.test 先例）。
- **回归**：demo 页（改用 HandwritingPad 后）与语文专项两页现有测试全部保持通过。

## 8. 上线判断

实现 + 测试全绿后，人工验收路径：真实手写整篇默写（分批）→ 校对回填 → 提交判题，验证与键盘输入流程结果一致；本地模型识别延迟可接受（单批 ≤ 数秒）。
