# 计划：可复用 BackButton / LogoutButton 控件

## 目标
把散落各处、风格不一的「返回」与「退出登录」按钮收敛为两个 base 控件：指定目标即跳转，逻辑集中不重复。

## 新增控件（`apps/web/src/components/base/`）

### `BackButton.tsx`
- props：`to: string`（目标路径）、`label: string`（用于 `title` + `aria-label`，如「返回学科选择」）、`state?: unknown`（可选导航 state）、以及 `ButtonHTMLAttributes` 透传（含 `className` 覆盖）。
- 固定风格 = 知识星图那个圆形白底按钮（用户指定基准）：
  `p-2.5 rounded-full bg-white border border-slate-200 shadow-sm hover:bg-slate-50 transition-colors text-slate-600`
- 内置 `ArrowLeftIcon`（chevron-left，与 StarMap/CourseDetail 现用一致：`polyline 15 18 9 12 15 6`，w-5 h-5，strokeWidth 2.5）。
- `onClick={() => navigate(to, state !== undefined ? { state } : undefined)}`。
- 属性行序保证 `onClick/title/aria-label/className` 覆盖透传值。

### `LogoutButton.tsx`
- props：`label?: string`（默认「退出登录」）、`onLogout?: () => void`（清存储前的额外清理，如重置 store）、`ButtonHTMLAttributes` 透传。
- 集中登出逻辑：`onLogout?.()` → 清 `token/userId/username/userRole` → `navigate('/login')`。
- 默认沿用同一圆形白底风格，`className` 可覆盖（如侧栏里想更克制可传 ghost 类）。
- 内置 `LogOutIcon`（门+箭头，即现 ExitIcon/LogOutIcon 样式）。

### `index.ts`
- 导出 `BackButton`、`LogoutButton`。

## 改造调用点

| 文件 | 现状 | 改为 |
|---|---|---|
| StarMapPage.tsx:228-234 | 圆形按钮 + 本地 ArrowLeftIcon | `<BackButton to="/student/subjects" label="返回学科选择" />`；删本地 ArrowLeftIcon |
| ConversationManagePage.tsx:158-163 | 文字+图标 ghost「返回答疑」 | `<BackButton to="/student/auxiliary" label="返回答疑" />`；删本地 BackIcon |
| CourseDetailPage.tsx:349-355 | 文字+图标 pill「返回关卡星图」(带 state) | `<BackButton to="/student/star-map" label="返回关卡星图" state={{ subjectId }} />`；保留 state 传参 |
| CourseDetailPage.tsx:426-438 | 内联清存储 + 本地 LogOutIcon | `<LogoutButton />`；删本地 LogOutIcon |
| AuxiliaryHomePage.tsx:99-104 | 文字+图标 ghost「返回入口」 + handleBackToEntry | `<BackButton to="/student/entry" label="返回入口" />`；删 handleBackToEntry + 本地 BackIcon |
| AuxiliaryHomePage.tsx:85,124-129 | handleLogout + ExitIcon | `<LogoutButton onLogout={() => { reset(); setCurrentDialogueId(null); }} />`；删 handleLogout + 本地 ExitIcon |

实现时 grep 确认各本地 icon 仅被这一处使用后再删；多处复用的保留。

## 两个风格决策（请确认）
1. **返回按钮统一为「圆形图标 only」**：`返回答疑 / 返回关卡星图 / 返回入口` 的可见文字消失，改入 `title` 提示 + `aria-label`。这是「固定成一个风格」的直接结果，但属可见变化。
2. **退出按钮也默认同一圆形白底风格**：CourseDetail（现红 hover ghost）、AuxiliaryHomePage（现灰 ghost）都变圆形白底。侧栏底部那颗会变重一些；如想保持克制，可给该处传 `className` 降级（如 `border-transparent shadow-none text-[#86868B] hover:bg-[#F9F9FB]`）。

## 不在范围
- 不新增 auth store / 路由守卫（沿用现有 localStorage 约定）。
- EntrySelectPage、SubjectSelectPage 现无返回按钮，不主动加。

## 验证
- `npm run lint` + `npm run build`（tsc -b）通过。
- 手动：登录→入口→答疑，顶部「返回入口」回入口页；底部「退出登录」回登录页；星图/课程详情/会话管理返回各自目标；CourseDetail 返回星图后科目 state 不丢。
