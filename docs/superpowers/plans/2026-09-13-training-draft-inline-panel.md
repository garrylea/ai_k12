# 训练轨草稿抽屉改并排占位（分割条调宽）— 实施记录

- 日期：2026-09-13
- 设计：`docs/superpowers/specs/2026-09-13-training-draft-inline-panel-design.md`
- 取代：`plans/2026-09-07-training-draft-drawer.md`（浮层抽屉初版）、`plans/2026-09-09-draft-drawer-width-resize.md`（40–85% 拖拽调宽）
- 触发：用户反馈「草稿是抽屉浮层，操作麻烦；改成占实际空间、QuestionRunner 左移、中间分割条调宽」

## 1. 用户确认的取舍

1. 默认仍是收起，点图标展开（展开=挤窄答题列，不再是遮挡）。
2. 宽度 25%–55%，默认 35%（原 40–85% / 默认 45% 不适合并排：85% 会把答题列挤到 15%）。
3. 去掉头部「放大/缩小」两档按钮，改为**双击分割条复位默认 35%**。

## 2. 改动清单

| 文件 | 改动 |
|---|---|
| `apps/web/src/components/business/DraftDrawer.tsx` → `DraftPanel.tsx` | `git mv` + 组件改名 `DraftPanel`/`DraftIconButton`；常量改 25/55/35、删 `WIDTH_SMALL/LARGE`；删 `expanded` 与头部放大/缩小按钮；`return` 改 fragment（分割条 + 卡片式面板）；拖拽基准由 `offsetParent` padding-box 改为**所在并排行宽**；新增双击复位；面板改与答题卡同款卡片（`rounded-xl border shadow-sm`），去掉浮层阴影 `--shadow-drawer`（该 token 仍由 `DiscussDrawer` 使用） |
| `pages/student/training/TargetedRunPage.tsx` | 答题分支加并排行 + `flex-1 min-w-0 min-h-0 flex flex-col` 答题列包 `QuestionRunner`；`DraftPanel` 进同行；图标改 `!draftOpen` 才渲染；DOM 顺序注释更新；import 改名 |
| `pages/student/training/ErrorPracticeRunPage.tsx` | 同上（`draftKeyPrefix="errp"`） |
| `pages/student/training/ExamRunPage.tsx` | 同上（`draftKeyPrefix={exam-${sid}}`，无 DiscussDrawer；`headerExtra` 倒计时与交卷失败层不动） |
| `components/business/answer/QuestionRunner.tsx` | 两处 `w-1/2` 补 `min-w-0`（防窄列被内容撑破）；`:504` 注释 `DraftDrawer` → `DraftPanel` |
| `components/business/DraftPanel.test.tsx`（新增） | 5 条：初始 35% / 无放大缩小按钮 / 拖拽夹紧 25、55 / 双击复位 / X 关面板 |

## 3. 实施中发现的细节

- **`flex-1` 的语义**：`QuestionRunner` 根是 `flex-1 min-h-0 flex flex-col`，依赖父级是 `flex-col`；并排后必须给它包一层 `flex-1 min-w-0 min-h-0 flex flex-col`，否则 `flex-1` 会变成横向增长。
- **叠放**：`DraftPanel` 自身是 static，但其内 canvas 是 `absolute`；与 `DiscussDrawer`（同样 `z-index:auto` 的定位元素）同处一个层叠上下文 → **按 DOM 序**绘制，所以并排行必须排在最前。已用 `elementFromPoint` 在真机确认讨论层盖住面板。
- **双击复位**：`onDoubleClick` 挂在分割条上，与 `setPointerCapture` 不冲突（不在 pointerdown 里 `preventDefault`）；拖拽中由 `resizeStartRef` 兜住误触发。
- **白板工具栏折行**：面板宽度跨过折行阈值时工具条会从一行变两行，画板可用高度变化一次（笔迹位置不变）。这是白板在窄容器下的既有行为（原抽屉 40% 同样如此），本次未改；若后续要消除，可把工具条改成 `flex-nowrap overflow-x-auto`。

## 4. 验证数据（真机 CDP，无头 Chrome）

| 视口 | 状态 | 行宽 | 草稿列 | 分割条 | 答题列 | 实测占比 | 横向溢出 |
|---|---|---|---|---|---|---|---|
| 1024×768 | 展开 | 981 | 343 | 10 | 628 | 35.0% | 0 |
| 1024×768 | 拖宽（夹上限） | 981 | 539 | 10 | 432 | 55% | 0 |
| 1024×768 | 拖窄（夹下限） | 981 | 245 | 10 | 726 | 25% | 0 |
| 1024×768 | 双击复位 | 981 | 343 | 10 | 628 | 35.0% | 0 |
| 1440×900 | 展开 / 拖宽 / 拖窄 / 复位 | 1394 | 488 / 688 / 348 / 488 | 10 | 余量 | 35 / 49.3 / 25 / 35% | 0 |

- 收起态：面板不渲染、答题列 = 行宽、右上角「草稿」图标可见；展开态图标隐藏。
- 讨论层（排在行之后的 `absolute` 浮层）`elementFromPoint` 命中自身 → 正确盖在草稿面板之上。
- 静态检查：`npx vitest run` 64/64 绿（新增 5 条 + 既有 59 条）、`npx tsc -b` 通过、`npx eslint src/` 0 error。
