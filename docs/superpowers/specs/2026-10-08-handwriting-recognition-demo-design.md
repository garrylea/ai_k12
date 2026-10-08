# 手写汉字识别率调研 demo — 设计文档

日期：2026-10-08
状态：已与用户逐节确认（方案 A）

## 1. 背景与目标

PRD §8/§7.12/§15 将「手写输入」列为后续迭代，且明确以「识别准确率达标」为落地前置条件。本 demo 是该前置条件的调研工具：**只识别手写汉字**（不含公式），回答一个问题——现有多模态大模型对手写汉字的识别率是否足够。

用户已确认的四个口径：

| 决策点 | 结论 |
|---|---|
| 识别对象 | 只要汉字，不做公式 |
| 形态 | web 应用内开发页（不进导航）+ 极简后端端点，模型配置真源走 DB registry |
| 评估 | 自动逐字比对（对照文本 → 字级准确率），不留档 |
| 模型 | 可切换多模型横向对比（下拉来自 registry） |

## 2. 非目标（有意不做）

- 留档 / 导出 JSON / 批量自动化脚本
- 撤销 / 重做、圆规、图形工具、贴图、选中（白板精简复制只留笔/橡皮/清空）
- 移动端适配（iPad 可写即可）
- 识别结果落库、request-log（调研用完即弃）
- 多模态能力的配置化判定（registry 无该字段，见 §5.1）

## 3. 架构与数据流

```
demo 页 /dev/handwriting-demo（apps/web，不进导航，写死日间主题）
  ① 用户填「对照文本」（已知答案）
  ② 手写面板写汉字 → 点「识别」→ 离屏 canvas 白底黑字导出 dataURL
  ③ POST /api/dev/handwriting/recognize { image, modelKey }
  ④ 后端从 registry 取该模型配置，纯转写 prompt + image_url 部件直调（非流式）
  ⑤ 前端归一化 → LCS 逐字比对 → 三栏展示（原图/对照/识别）+ 字级准确率 + 错字清单
  ⑥ 每轮记录存页面内存，顶部显示累计准确率；刷新即清空，不留档
```

## 4. 前端设计（apps/web）

### 4.1 路由与页面

- 路由 `/dev/handwriting-demo`，全屏、不在任何 Layout 下、`data-theme="student-day"` 写死（非学习沉浸页，无日夜切换）。
- 页面组件 `HandwritingDemoPage.tsx`：控制条 + 手写面板 + 结果区（三栏：原图 / 对照 / 识别）。

### 4.2 手写面板 `DemoSketchPad.tsx`

- 从 `DraftWhiteboard.tsx` **精简复制**，不动原组件（避免答题弹窗回归风险）。
- 保留：单 canvas + Pointer Events + dpr 缩放 + 二次贝塞尔平滑（同 `strokePath` 逻辑）；数据结构同构 `Stroke { points: DraftPoint[] }`。
- 工具仅三项：**笔 / 橡皮（笔画级）/ 清空**。
- 画布固定逻辑尺寸 720×360；无笔画时「识别」按钮禁用。

### 4.3 导出（新增逻辑，原白板没有）

- 离屏 canvas：白底 + 深色笔迹（导出**不随主题**，模型对白底黑字最稳）。
- `lineWidth = 3`（白板原 2px 偏细，汉字识别需笔画清晰）。
- `toDataURL('image/png')`。

### 4.4 控制条

- 模型下拉：数据来自 `GET /api/dev/handwriting/models`。
- 对照文本输入框（多行）。
- 「识别」按钮。

## 5. 后端设计（apps/server，新模块 `modules/dev/`）

### 5.1 GET /api/dev/handwriting/models

- 取 `getModelConfigRegistry().getSnapshot().models`，只暴露 `key / provider / modelId`，**绝不返回 apiKey**。
- registry 无多模态标记字段，列表返回**全部已启用模型**，由调研者自行选多模态的（qwen3.8-max 等）。
- 返回形状：`{ models: [{ key: string, provider: string, modelId: string }] }`。
- 错误：registry 未初始化 → 503。

### 5.2 POST /api/dev/handwriting/recognize

请求 body：`{ image: string, modelKey: string }`。

校验（顺序执行，任一失败即返回，不再继续）：

| 步骤 | 校验 | 失败返回 |
|---|---|---|
| 1 | `image` 匹配 `^data:image/(png|jpeg);base64,` | 400 |
| 2 | base64 解码后 ≤ 4MB | 400 |
| 3 | `modelKey` 存在于 registry snapshot.models | 404 |

逐步逻辑：

1. 从 snapshot 取该 modelKey 的完整配置（provider/modelId/baseUrl/apiKey）。
2. 构造 messages：
   - system：`你是 OCR 引擎。把图片中的手写汉字逐字转写为简体中文纯文本，只输出转写结果本身，不要输出任何解释或多余符号。无法辨认的字输出最接近的猜测。`
   - user：`[{type:'text', text:'转写'}, {type:'image_url', image_url:{url: dataURL}}]` —— 部件格式与 `tutoring.capability.ts:305` 同构。
3. 复用 ai-core 现有 LLM 客户端，**指定 modelKey 对应模型**，非流式调用。
4. 返回前剥离空白首尾。

返回形状：`{ text: string, modelKey: string, elapsedMs: number }`。

错误：上游模型调用失败 → 502 `{ message: 简化错误信息 }`。

权限：任一已登录角色（走现有 JWT 全局 guard）。

## 6. 比对与评估口径（纯前端纯函数 `handwriting-diff.ts`）

- **归一化** `normalize(s)`：去所有空白与标点（中/西文）、全角→半角、英文统一小写。
- **比对**：归一化后按 code point 序列做 **LCS 对齐**，得匹配数。
- **字级准确率 = 匹配数 ÷ 期望字数**；多识别的字单独列「多出」清单、**不冲抵准确率**（避免漏字被多字掩盖）。
- **每轮结果**：`{ expected, recognized, accuracy, errors: [{expected, got|null}], extra: string[], image }`；`errors` 由 LCS 对齐产出错字/漏字对照，`image` 为当轮导出图供回看。
- **累计**：页面顶部显示全部轮次合并后的总准确率与轮数（内存累计，刷新清空）。

## 7. 测试

- **单测**：`handwriting-diff.ts` 归一化 + LCS 对齐 + 错字/漏字/多出清单（纯函数全覆盖）；controller 校验（image 格式非法、超限、modelKey 不存在）。
- **组件测试**：`DemoSketchPad` 渲染与按钮禁用态（无笔画禁用识别）；结果区渲染。遵守「组件改动必须补渲染测试」与 `globals: false` 需自写 `afterEach(cleanup)` 的仓规。
- 回归确认：不动 `DraftWhiteboard` 原组件，现有草稿白板测试不应有变化。

## 8. 上线后判断标准（调研产出）

调研结论以页面累计字级准确率 + 错字清单人工复核为准。达标阈值本 spec 不预设——由用户根据累计数据裁决「手写直接作为答案提交」是否立项。
