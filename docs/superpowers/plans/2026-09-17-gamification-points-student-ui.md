# 闯关积分体系 · 学生端 UI 实施计划（三份之二）

- 日期：2026-09-17
- 依据：`docs/superpowers/specs/2026-09-17-gamification-points-design.md` §6.1、§7.1–7.2、§8.1、§8.3
- 前置：**计划一（后端）已完成**，提交 `2f58fce..f89d063`
- 状态：**待实施**

---

## 0. 范围与依赖

本文只做**学生端**（用户能直接看到的部分）。家长端配置/兑换是计划三。

**计划一交付的接口（本文全部依赖，均已实现且有测试）**：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/points/me` | `{ balance, totalEarned, todayEarned, level:{code,name,index,threshold}, nextLevel:{code,name,threshold}\|null, pointsToNextLevel:number\|null, progressPercent:number }` |
| GET | `/api/points/me/ledger?page&pageSize` | `{ items:[{id,kind,title,points,createdAt,refType}], total, page, pageSize }` |
| GET | `/api/points/me/rules` | `{ tasks:[{taskCode,taskName,tiers:[{tierKey,tierLabel,points,dailyLimit,completedToday,remainingToday}]}] }` |
| GET | `/api/points/me/rewards` | `{ balance, level, items:[{id,name,description,pointsCost,minLevelCode,minLevelName,affordable,levelOk,gap}] }` |
| POST | `/api/training/sessions/:id/complete` | `{ pointsAwarded, balance\|null, totalEarned\|null, levelUp:{from,to}\|null, reason? }` |
| POST | `/api/progress/update` | 追加可选 `points?: { awarded, balance, levelUp:{from,to}\|null }` |
| POST | `/api/exams/sessions/:id/submit` | 追加可选 `points?: {...同上}` |
| POST | 各判题端点 | 追加 `pointsAwarded: number` + `awardReason?` |

**`levelUp.from` / `to` 是段位 code 字符串**（`'pichai'` / `'zhutie'`），不是对象——前端只拿它查图标。

---

## 1. 全局约束（每条都会被审查）

### 1.1 计划一带过来的必做项（漏了会真坏）

1. **`TargetedConfigPage.tsx:25` 的 `COUNT_OPTIONS = [3,5,8,10]` 必须删掉、改读 `GET /api/points/me/rules`。** 新默认档位是 `[1,3,5,10]`，而计划一给两个 `start` 端点加了**档位白名单校验**——不改的话学生点「8 题」会被 **400 拒绝**。`VocabularyConfigPage.tsx:14` 的 `[10,15,20]` 与默认值一致，无破坏，但同样要改读接口。
2. **`me/rules` 可能返回空 `tiers` 数组**（该任务的档位被家长全部下架）。前端**不能**写 `tiers[0].tierKey` 这类默认取值；空数组时该任务卡显示「家长已停用」并禁用开练。
3. **`complete` 的 `balance` / `totalEarned` 可能是 `null`**（`reason: 'award_failed'`，奖励未入账）。前端收到 `null` 时**不要**拿它覆盖本地积分快照，且要允许用户重试（会话留在 `in_progress`，重试会补发）。
4. **幂等命中/已达上限时 `pointsAwarded` 是 0**。不要因为 `pointsAwarded === 0` 就报错或弹负面文案——超上限时文案是「今日该任务积分已达上限」，重复时静默。

### 1.2 仓内硬规则

1. **不用 emoji**；图标必须是**线性 SVG**。
2. **不引入新色板**：段位配色只用 `style.md` §2.1 的 brand 色阶（`Brand-500 #ff6b35` / `400 #ff8555` / `600 #e85a28` / `100 #fff0e8`）与语义色（`Success #4A9B6E` / `Warning #D89844` / `Error #C44A3F` / `Info #4A7BA6`），靠**明度阶 + 图标构图**区分 9 个段位。
3. **训练轨内页面一律硬编码 `data-theme="student-day"`**（不跟随主题、无切换按钮）；`StudentLayout` 下的页面（星图/课程详情/错题本/个人中心）才跟随主题。**庆祝页与积分反馈组件两处都要能用**，所以它们的颜色**必须走 CSS 变量**，不能写死。
4. iPad 横屏（≥1024px）是主断点。
5. 苏格拉底原则：「提示」「讨论」永远比「看答案」更醒目——**积分反馈不能遮挡或抢注意力于答题控件**（所以轻反馈放右下角，不放中央）。
6. 组件改动**必须补渲染测试**。
7. `@testing-library/react` 配 `globals: false`：**多用例文件必须自己写 `afterEach(() => cleanup())`**。
8. `services/api.ts` 是单文件、按 `// --- 模块 ---` 分区；`fetchApi` 自动带 Bearer 并解 `{code,message,data}`，非 0 抛 `ApiError`。
9. 状态用 Zustand；主题/动效偏好已有 `themeStore`，**动效偏好要尊重**（`motion_enabled`；烟花遇 `prefers-reduced-motion` 降级）。

---

## 2. 组件契约（先定接口，再并行做）

### 2.1 `LevelIcon`（`components/base/LevelIcon.tsx`）

```ts
export type LevelCode =
  | 'pichai' | 'zhutie' | 'qingtong' | 'baiyin' | 'huangjin'
  | 'bojin' | 'zuanshi' | 'xingyao' | 'wangzhe';

interface LevelIconProps {
  code: LevelCode | string;   // 容错：后端加了新段位也不能崩
  size?: number;              // 默认 24
  className?: string;         // 用 text-[color] 控色（currentColor）
}
```

- **一个文件 9 个 SVG 片段**（`Record<LevelCode, ReactNode>`），不建 9 个小文件。
- 统一 `viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、`strokeWidth={2}`、`strokeLinecap="round"`、`strokeLinejoin="round"` —— 与仓内既有图标（如 `LogoutButton` 的 `LogOutIcon`）同风格。
- 构图从低到高递进，建议：柴堆 → 铁砧 → 鼎 → 盾 → 冠 → 翼 → 菱 → 星芒 → 王座。
- **未知 code 回退到 `pichai`**，不抛错、不渲染空白。
- 明度阶在调用侧用 className 给（如 `text-[var(--brand-600)]`），组件本身不决定颜色。

### 2.2 `PointsToast`（`components/business/PointsToast.tsx`）+ `store/pointsStore.ts`

```ts
// pointsStore
interface PointsToastItem {
  id: string;
  points: number;            // 0 = 已达上限，文案不同
  title: string;             // 如「英语背单词 · 10 词」
  levelUp?: { from: string; to: string } | null;
}
interface PointsState {
  queue: PointsToastItem[];
  push(item: Omit<PointsToastItem, 'id'>): void;
  dismiss(id: string): void;
}
```

- 右下角浮出，**2.5s 自动消失**，多条**纵向排队**（不叠成一坨）。
- 文案：`points > 0` → `+N 分`；`points === 0` → 「今日该任务积分已达上限」，**不显示负数、不显示红色**（不是错误）。
- **`levelUp` 非空时不在这里庆祝**——交给 `CelebrationOverlay`（全屏），`PointsToast` 只负责轻反馈，避免两处同时弹。
- `z-index` 要低于答题弹窗（不能盖住「提示/讨论/提交」）。
- 尊重 `prefers-reduced-motion` 与 `themeStore.motionEnabled`：关动效时直接出现/消失。

### 2.3 `FireworksCanvas`（`components/business/FireworksCanvas.tsx`）

```ts
interface FireworksCanvasProps {
  active: boolean;      // false 时不渲染 canvas、不跑 RAF
  intensity?: 'full' | 'soft';  // 默认 'full'；'soft' 用于 task 变体（烟花更淡）
  onDone?: () => void;  // 约 3s 后回调
}
```

- **Canvas 2D + `requestAnimationFrame`**，纯代码生成粒子——**不用图片素材、不用 `✦✧＊·◇` 之类装饰字符**。
- 规模：每波 ≤120 粒子 × 3 波，总计约 3 秒后自动卸载并 `onDone`。`'soft'` 档减半粒子数并降 alpha（Task 3 实现：full 90 粒子/波、soft 45 粒子/波 + 0.5 alpha），**两档都不得越过 120 上限**。
- 按 `devicePixelRatio` 缩放 backing store（`ctx.setTransform`），否则 iPad retina 上粒子发虚——iPad 横屏是本项目主断点。
- 颜色**读 CSS 变量**（`getComputedStyle(el).getPropertyValue('--brand-500')` 等，记得 `.trim()`），这样日夜主题、训练轨硬编码日间主题下都对。
- `prefers-reduced-motion: reduce` 或动效关闭 → **不跑动画**，直接 `onDone()`（父组件改为静态光晕）。
- 必须清理：`cancelAnimationFrame` + 组件卸载时停止，别留后台 RAF。

### 2.4 `CelebrationOverlay`（`components/business/CelebrationOverlay.tsx`）

```ts
interface CelebrationOverlayProps {
  open: boolean;
  variant: 'task' | 'levelup';
  title: string;                  // 如「本节学习完成！」/「晋升 铸铁！」
  subtitle?: string;
  pointsAwarded?: number;         // 只读展示
  level?: { code: string; name: string };  // levelup 时显示大图标
  primaryLabel: string;           // 「开始新课」/「继续」
  onPrimary: () => void;
  autoCloseSeconds?: number;      // 给了就倒计时自动触发 onPrimary
}
```

- 全屏覆盖层，**背景半透明遮罩 + 居中卡片**（不是不透明整面——这个组件还要复用到训练轨交卷），`role="dialog"` + `aria-modal="true"`。
- 视觉：`variant === 'levelup'` 时显示 `LevelIcon` 大图标（size 96）+ 段位名 + 烟花（`intensity='full'`）；`'task'` 时显示对勾圆 + 烟花（`intensity='soft'`，更淡）。
- 倒计时行由本组件渲染（给了 `autoCloseSeconds` 就显示「N 秒后自动继续」）；**去哪里的文案由调用方通过 `subtitle` 给**，组件不感知业务。
- **`aria-modal="true"` + `role="dialog"`**，焦点落在主按钮上。
- 现在主线那段内联庆祝（`CourseDetailPage.tsx:1022-1096`）里用 `✦✧＊·◇` 做的撒花**一并换成 `FireworksCanvas`**——那是违反「不用装饰元素」硬规则的存量代码，这次顺手修掉。

### 2.5 `UserBadge` + `LevelPanel`

**`UserBadge`（`components/business/UserBadge.tsx`）**

```ts
interface UserBadgeProps {
  username: string;
  initial?: string;
  className?: string;
}
```

- 药丸：头像 + 名字 + `LevelIcon`（小）+ 可用积分。**点击打开 `LevelPanel`**（不再是退出）。
- **退出登录拆成独立图标按钮**——`LogoutButton` 保持原样（家长端/管理端继续用它），学生端改成 `UserBadge` + `LogoutButton` 并排。
- 改用的三处：`EntrySelectPage.tsx:76`、`CourseDetailPage.tsx:658`、`AuxiliaryHomePage.tsx:79`。
  注意 `CourseDetailPage.tsx:647-660` 那块是左侧底部用户区（含「专注学习中...」），改动时保持布局。

**`LevelPanel`（`components/business/LevelPanel.tsx`）** — 用户点用户信息要看的东西

- 内容：大 `LevelIcon` + 段位名 + **可用积分** + **累计积分** + **距下一档还差多少分** + 进度条（`progressPercent`）+ 「查看积分明细 →」跳 `/student/profile`。
- 满级（`nextLevel === null`）：不显示「还差」，进度条 100%，文案「已达最高段位」。
- 打开时调 `GET /api/points/me`；**加载中不发抖**（用骨架屏，别先渲染 0 再跳成真实值）。
- 形态：桌面用 popover/下拉，窄屏用底部抽屉；点外部关闭，Esc 关闭。
- **段位未加载出来时不显示「劈柴 0 分」**——先骨架，避免孩子以为自己归零。

---

## 3. 任务清单

### Task 1: `LevelIcon` + 段位常量

**Files**
- Create: `apps/web/src/components/base/LevelIcon.tsx`
- Create: `apps/web/src/components/base/LevelIcon.test.tsx`
- Modify: `apps/web/src/components/base/index.ts`（桶导出）

**要点**：9 个 SVG，未知 code 回退 `pichai`。

**测试**：9 个 code 各渲染一次且 `svg` 存在；传未知 code 不抛错且渲染出 `pichai` 的 path；`size` 生效；`className` 透传到 svg。

**提交**：`feat(web): 段位图标组件（9 个线性 SVG）`

---

### Task 2: `pointsStore` + `PointsToast` + `api.ts` 学生端接口

**Files**
- Create: `apps/web/src/store/pointsStore.ts`
- Create: `apps/web/src/components/business/PointsToast.tsx`、`.test.tsx`
- Modify: `apps/web/src/services/api.ts`（新增 `getMyPoints` / `getMyLedger` / `getMyPointRules` / `getMyRewards` / `completeTrainingSession`）
- Modify: `apps/web/src/App.tsx` 或 `StudentLayout`（挂载 `<PointsToast />` 一次）

**要点**：队列、2.5s 自动消失、`points === 0` 文案不同、`z-index` 低于答题弹窗。

**测试**：`push` 后出现 `+2 分`；2.5s 后消失（`vi.useFakeTimers`）；`points: 0` 显示上限文案；多条排队不互相覆盖。

**注意**：`afterEach(() => cleanup())`。

**提交**：`feat(web): 积分轻反馈（pointsStore + PointsToast）+ api 学生端接口`

---

### Task 3: `FireworksCanvas` + `CelebrationOverlay`，并替换主线内联庆祝

**Files**
- Create: `apps/web/src/components/business/FireworksCanvas.tsx`、`.test.tsx`
- Create: `apps/web/src/components/business/CelebrationOverlay.tsx`、`.test.tsx`
- Modify: `apps/web/src/pages/student/CourseDetailPage.tsx:1022-1096`（删掉内联庆祝，改用 `CelebrationOverlay`）
- Modify: `apps/web/src/components/business/index.ts`

**要点**：见 §2.3 / §2.4；`progress.service.ts` 的 `finishLesson` 响应里现在带 `points`，接到后 `push` 轻反馈；`completed: true`（整学科完成）时用全屏庆祝。

**测试**
- `FireworksCanvas`：`active=false` 不渲染 canvas；`active=true` 且在 reduce-motion 下**不**调 `requestAnimationFrame` 而是直接 `onDone`；卸载后无残留 RAF（`vi.spyOn`）。
- `CelebrationOverlay`：两个 variant 各自渲染标题/主按钮；`autoCloseSeconds` 到点触发 `onPrimary`；`level` 时渲染 `LevelIcon`。
- **主线回归**：`CourseDetailPage` 完成态仍能弹出庆祝并调用正确回调（这是计划一审查点名的回归重点，参照 `SentenceBlock.test.tsx` 那次 React #31 的教训）。

**提交**：`feat(web): 庆祝层抽公共组件 + Canvas 烟花，替换主线内联撒花`

---

### Task 4: `UserBadge` + `LevelPanel`，接上用户信息入口

**Files**
- Create: `apps/web/src/components/business/UserBadge.tsx`、`.test.tsx`
- Create: `apps/web/src/components/business/LevelPanel.tsx`、`.test.tsx`
- Modify: `apps/web/src/pages/auth/EntrySelectPage.tsx:76`
- Modify: `apps/web/src/pages/student/CourseDetailPage.tsx:647-660`
- Modify: `apps/web/src/pages/student/AuxiliaryHomePage.tsx:79`

**要点**：见 §2.5。**只有学生端**用 `UserBadge`；家长端/管理端保持 `LogoutButton` 不动。

**测试**
- `UserBadge`：渲染用户名与段位图标；点击触发打开 `LevelPanel`（用回调或 store 断言）；**不再触发退出**（退出是独立按钮）。
- `LevelPanel`：加载中显示骨架**而非 0 分**；加载完成显示段位名 + 可用积分 + 「还差 N 分」；`nextLevel === null` 时显示「已达最高段位」且不显示「还差」。
- 三个接入页各补一条渲染测试，确认 `UserBadge` 在（防回归）。

**提交**：`feat(web): 用户信息入口改段位入口（UserBadge + LevelPanel）`

---

### Task 5: 个人中心页（`/student/profile`）+ 奖励册（`/student/rewards`）

**Files**
- Create: `apps/web/src/pages/student/ProfilePage.tsx`、`.test.tsx`
- Create: `apps/web/src/pages/student/RewardsPage.tsx`、`.test.tsx`
- Modify: `apps/web/src/routes/index.tsx:366-367`（把两个 `Placeholder` 换成真页面）

**个人中心内容**：段位大卡（`LevelIcon` + 名称 + 进度条 + 距下一档）→ 积分概览（可用 / 累计 / 今日）→ 积分流水列表（分页，`me/ledger`；`kind='redeem'` 的负流水用中性色不用红色）→ 兑换记录（若计划三已上，可先留空态）。

**奖励册内容**：`me/rewards` 的奖励卡列表——名称/描述/所需积分/「还差 N 分」；`affordable && levelOk` 时高亮「可兑换」，否则置灰；**明写「找家长兑换」**（学生端不可自助兑换，这是 spec 定的）。

**测试**：两页各自——加载中骨架；空态文案（无流水 / 无奖励）；流水渲染正负分不同样式；奖励卡三种状态（可兑 / 分不够 / 段位不够）。

**提交**：`feat(web): 个人中心与奖励册（段位、积分、流水、奖励）`

---

### Task 6: 训练配置页改读档位接口（**必做，否则「8 题」会 400**）

**Files**
- Modify: `apps/web/src/pages/student/training/TargetedConfigPage.tsx:25`（删 `COUNT_OPTIONS`）
- Modify: `apps/web/src/pages/student/training/english/VocabularyConfigPage.tsx:14`（删 `COUNT_OPTIONS`）
- Modify: 两个页的测试

**要点**
- 档位来源改为 `getMyPointRules()`，按 `taskCode` 取 `tiers`，渲染成原来的横向按钮组（`tierLabel` 作按钮文字，如「3 题」「15 词」）。
- **空 `tiers` 时**：该任务卡显示「家长已停用该任务」，按钮禁用、不给默认值。
- 默认选中项：第一个档位（原来是硬编码 5 / 10，现在取 `tiers[0]`）。
- `dailyLimit != null` 时，档位按钮上显示剩余次数（`remainingToday === 0` 时置灰但**仍可开练**——只是不发分，别拦着孩子练）。
- 加载态：档位未到之前按钮区显示骨架，**不要**先渲染旧常量再替换。

**测试**：档位渲染自接口；空 `tiers` 显示停用文案且按钮禁用；`remainingToday: 0` 时显示「今日已达上限」但仍可点击。

**提交**：`feat(web): 训练配置页档位改读积分规则接口`

---

### Task 7: 训练 run 页接发分反馈

**Files**
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`（完时调 `completeTrainingSession`）
- Modify: `apps/web/src/pages/student/training/english/VocabularyRunPage.tsx`（同上）
- Modify: `apps/web/src/pages/student/training/ExamResultPage.tsx`（交卷响应里的 `points` → **全屏庆祝**）
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`（读判题响应的 `pointsAwarded` → 轻反馈）
- Modify: `apps/web/src/pages/student/training/chinese/{Dictation,Interpretation,Meaning}RunPage.tsx`（同上）
- 各页测试

**要点**
- **只有数学专项与背单词走会话**（调 `completeTrainingSession(sessionId)`）；其余四项**不调完成接口**，判题响应里已带 `pointsAwarded`。
- `complete` 返回 `balance === null`（`award_failed`）时：**不更新本地积分、不弹负反馈**，提示「积分稍后到账，可重试」，并允许再点一次完成（服务端会补发）。
- `levelUp` 非空 → 全屏 `CelebrationOverlay variant="levelup"`；否则 `PointsToast`。
- 交卷（`ExamResultPage`）走全屏庆祝（大任务），分数与积分都要显示。
- **`pointsAwarded === 0` 且 `awardReason === 'daily_limit'`** → 轻反馈文案「今日该任务积分已达上限」，中性色。

**测试**：每页至少一条——拿到 `pointsAwarded` 时 `pointsStore.push` 被调用且参数正确；`levelUp` 时走全屏而没有轻反馈；`balance === null` 时不污染本地积分且有重试提示。

**提交**：`feat(web): 训练各页接发分反馈与升级庆祝`

---

### Task 8: 路由与导航收尾

**Files**
- Modify: `apps/web/src/routes/index.tsx`（确认两个 Placeholder 已替换）
- Modify: `apps/web/src/components/layout/StudentNav.tsx`（「奖励册」「个人中心」已在侧栏，确认图标/顺序）

**测试**：路由渲染测试——`/student/profile` 与 `/student/rewards` 渲染真页面而非 Placeholder。

**提交**：`chore(web): 积分相关路由与导航收尾`

---

## 4. 验收（人工）

```bash
cd apps/web && npm run build && npm test
cd ../server && node dist/main.js          # 必须 node dist/main.js
cd ../web && npm run dev
```

用学生账号走一遍：
1. 星图/课程页右上角点自己的名字 → 面板显示**劈柴 0 分 / 还差 500 分升铸铁**（不是空白也不是报错）。
2. 学完一课 → 右下角 `+10 分` 轻反馈 + 主线原有全屏庆祝（烟花，无 `✦✧` 字符）。
3. 数学专项配置页 → 题量按钮是 **1/3/5/10 题**（不是 3/5/8/10），且每档显示分值。
4. 做完一轮专项 → `+N 分`；连做到超上限 → 中性文案「今日该任务积分已达上限」。
5. 背单词做完一轮 → `+N 分`（每天两轮内）。
6. 做到跨越 500 分 → **全屏晋升庆祝**（铸铁，大图标 + 烟花）。
7. 个人中心 → 段位卡 + 流水（含负数的兑换行）。
8. 奖励册 → 奖励卡与「还差 N 分」。
9. 切夜间模式 → 段位图标、进度条、烟花都还看得清；训练轨页面仍为日间（不受主题影响）。

## 5. 风险

| 风险 | 处置 |
|---|---|
| 抽公共庆祝组件动了主线现有流程 | Task 3 必须补 `CourseDetailPage` 完成态回归测试 |
| `me/rules` 返回空 `tiers` 导致前端崩 | Task 6 显式处理空数组；这是计划一审查点名的必做项 |
| `complete` 返回 `null` 余额污染本地状态 | Task 7 显式处理 `balance === null` |
| 烟花在 iPad 上卡顿 | 粒子上限 120/波、3 秒卸载、reduce-motion 降级 |
| 段位图标「明度阶」不够区分 | 配色只用 brand 色阶，靠**构图**承担区分度；若实测区分不清，回退方案是在图标外加一圈 brand-100 底 |
| 轻反馈盖住答题控件 | `z-index` 低于答题弹窗；只放右下角 |
