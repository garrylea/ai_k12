# 训练轨草稿面板：并排占位 + 分割条调宽 — 设计文档

- 日期：2026-09-13
- 范围：`apps/web/src/components/business/DraftPanel.tsx`（原 `DraftDrawer.tsx`）、`apps/web/src/pages/student/training/{Targeted,ErrorPractice,Exam}RunPage.tsx`、`apps/web/src/components/business/answer/QuestionRunner.tsx`（两处 `min-w-0`）
- 取代：`2026-09-07-training-draft-drawer-design.md`（浮层抽屉形态）、`2026-09-09-draft-drawer-width-resize-design.md`（40–85% 拖拽调宽）
- 关联：`2026-09-02-math-training-module-design.md`（`draftKeyPrefix` 草稿键隔离）、`2026-09-08-draft-paste-image-design.md`（贴图）

## 1. 背景与目标

页面级草稿原先做成**浮层抽屉**（`absolute top-0 right-0 bottom-0`）压在答题区上：用户反馈「每次要开关、还挡着题面，操作麻烦」。改为**占真实空间的并排面板**——答题列向左收缩、草稿列占位、中间一根分割条拖拽调宽。

## 2. 已确认决策

| 决策点 | 结论 |
|---|---|
| 默认状态 | 默认收起；点右上角「草稿」图标展开（展开是**挤窄**答题列，不是遮挡） |
| 图标可见性 | 仅面板**收起**时渲染（展开时面板头部自带收起按钮，避免图标压在面板上） |
| 宽度范围 | 25%–55%（占并排行宽），默认 35% |
| 宽度调整 | 分割条拖拽（左移变宽 / 右移变窄）+ **双击分割条复位默认 35%**；不做「放大/缩小」两档按钮 |
| 宽度记忆 | 模块级会话变量：本会话内跨页、跨开关保持，刷新回默认 |
| 讨论抽屉 | 不动，仍是右浮层，**盖在**草稿面板之上（DOM 顺序铁律，见 §5） |
| 窄屏 | 不退化回浮层（PRD 硬规则 5 移动端 deferred）；1024px iPad 横屏下 25–55% 两侧都可用 |
| 持久化 | 保持 2026-09-09 起的现状：草稿落 `draft-store`，键 `${draftKeyPrefix}-${questionId}`，切题隔离、提交清空 |

## 3. 布局结构

```tsx
<div className="relative h-screen flex flex-col p-4 sm:p-6 …">      {/* 页面容器（三页同构） */}
  <div className="flex-1 min-h-0 flex">                            {/* 并排行 */}
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">         {/* 答题列：承接 QuestionRunner 的 flex-1 */}
      <QuestionRunner … />
    </div>
    {draftOpen && currentQ && <DraftPanel … />}                    {/* fragment：分割条 + 面板 */}
  </div>
  {!draftOpen && <div className="absolute top-4 right-4"><DraftIconButton … /></div>}
  {discussQ && phase === 'answering' && <DiscussDrawer … />}       {/* 必须排在并排行之后 */}
  <Modal … />                                                      {/* fixed z-50，天然在上 */}
</div>
```

要点：

- 答题列必须有 `min-w-0`：否则 `QuestionRunner` 内部 `w-1/2` 分栏的 `min-width:auto` 会撑破窄列、把草稿面板顶出可视区。`QuestionRunner` 两个 `w-1/2`（左编辑 / 右预览）已补 `min-w-0`。
- 结果页（`phase === 'result'` → `AnswerResultList`）不进并排行，全宽渲染；草稿只在作答态存在（无当前题无草稿）。
- 并排行宽 = 页面内容宽（`p-4 sm:p-6` 之内），`DraftPanel` 的 `width: N%` 与拖拽基准都以它为分母。

## 4. `DraftPanel` 组件规格

- 导出 `DraftPanel`（占位面板）与 `DraftIconButton`（入口图标）。
- `DraftPanel` 返回 **fragment**（两个并列 flex 子项，调用页直接放进 `flex` 行）：
  1. **分割条**：`role="separator" aria-orientation="vertical"`，`w-[10px] shrink-0 cursor-grab touch-none select-none` + 居中 2px 握把线（hover 加深）。事件 `onPointerDown/Move/Up/Cancel/LostPointerCapture` 调宽，`onDoubleClick` 复位。
  2. **面板**：`shrink-0 min-w-0 flex flex-col rounded-xl border border-[var(--learn-card-border)] shadow-sm overflow-hidden`，`style={{ width: 'N%', backgroundColor: var(--learn-card-bg) }}`，`transition-[width] duration-200`（拖拽中 `transition-none`）。头部 = 笔图标 + 「草稿」 + 收起 X；主体 = `flex-1 min-h-0` 包 `DraftWhiteboard scrollMode="scroll-y"`（key/questionId 同 store 键）。
- 拖拽数学：`baseW = 面板所在并排行的 getBoundingClientRect().width`（行无内边距，与 `width: N%` 同基准）；`pct = startPct + (startX - clientX) / baseW * 100`；**夹紧只有 `applyWidth` 一个入口**（25–55），拖拽落定与双击复位才写会话记忆；`baseW <= 0` 直接 return（未挂载/jsdom 保护）。
- 双击复位在 `resizeStartRef` 非空（拖拽中）时不响应，避免落定瞬间误触发。

## 5. DOM 顺序铁律

同层兄弟 `z-index` 均为 `auto`，**定位元素之间按 DOM 序绘制**：

1. 并排行（内含 `DraftPanel`，其画布是 `absolute`）必须排在 `DiscussDrawer` **之前** → 讨论抽屉才能盖住草稿面板。
2. 草稿图标必须排在 `DiscussDrawer` **之前** → 讨论抽屉打开时盖住图标，其关闭钮可点（沿用 2026-09-07 结论）。
3. `Modal`（`fixed z-50`）与考试交卷失败层（`fixed z-[60]`）不受顺序影响，恒在最上层。

## 6. 行为与已知取舍

- **拖宽不跳笔迹**：`scroll-y` 下画板高 = 容器高 × 1.6、笔迹存画板像素坐标 + `setTransform(dpr)` 1:1 重绘 → 拖分割条只改 `clientWidth`，笔迹锚定画板左上，不会平移/缩放（变窄时右侧笔迹被裁，变宽恢复）。
- **工具栏折行**：白板工具条是 `flex-wrap`，面板窄到一定程度（约 350px 以下）会折成两行，画板可用高度随之变化一次——这是白板自身在窄容器下的既有行为（原抽屉 40% 时同样发生），本次不改。
- 不抽公共 split-pane 组件：全仓库目前只有这一处拖拽调宽需求，等出现第二处再抽。
- 不做：窄屏自动退化浮层、键盘调宽、面板内嵌 tab 草稿（`PreviewDraftPanel`）改动。

## 7. 验证

- 单测 `apps/web/src/components/business/DraftPanel.test.tsx`（`vi.mock` 白板，jsdom 无布局靠 mock 行宽）：初始 35%、无放大/缩小按钮、拖拽夹紧 25/55、双击复位 35%、X 触发 `onClose`。
- 真机（CDP + 截图，1024×768 与 1440×900）：展开后 `答题列 + 分割条 + 草稿列 = 行宽`、无横向溢出、实测 35.0%；拖到 25%/55% 夹紧；双击回 35%；收起后答题列恢复全宽、图标仅收起时可见；行之后的 `absolute` 浮层 `elementFromPoint` 命中自身（即盖住面板）。
