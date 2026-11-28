# 学生好友与「发给同学」（共享题单）设计

**日期**：2026-11-28
**状态**：已废弃，由 `docs/superpowers/specs/2026-11-28-curated-question-set-design.md` 取代（2026-11-28 用户改为学生推荐、教研员按年级发布精选题单，不建设学生社交）
**关联**：
- 运行器复用：`apps/web/src/pages/student/training/TargetedRunPage.tsx`、`run-handoff.ts`
- 题单映射：`apps/server/src/modules/training/history-practice.service.ts`（`toRunQuestion`，第 251 行）
- 订阅门禁：`apps/server/src/modules/billing/subscription.guard.ts`（豁免清单不动）
- 实施计划：待写（`docs/superpowers/plans/2026-11-28-student-sharing.md`）

**写库边界（本设计不动的东西）**：

- **不改判题**：`modules/practice/judge-core.service.ts` 的判题、错题写入、掌握度回写、`error_fix` 发分一律不改。
- **不改积分**：不新增 `task_code`、不写 `training_sessions`、不调 `complete`。分享题的完成只写 `question_shares.completed_at`。
- **不改错题本来源枚举**：判题 `source` 沿用题目自身的 `questions.source`，**不新增 `shared`**。
- **不改订阅豁免清单**：`SUBSCRIPTION_EXEMPT` 一行不加，过期学生照旧被拦到锁定页。
- **不加聊天**：分享是「题单投递」，不含任何自由文本字段。

---

## 1. 结论

「学生 A 把 1~20 道题发给好友 B，B 点开就能做」在本系统成立，且**不需要新建答题页**：

专项练习的 `TargetedRunPage` 本来就是「题单运行器」，交接体是
`{sessionId, questions, title, mode}`，`questions` 允许 1..N 条；`mode='redo'` 已经是「单题、不建会话、不发分」的先例
（`PracticeHistoryDetailPage.tsx:441-455`、`TargetedRunPage.tsx:85-107`）。

所以本期的本质是：**把「题单从哪来」从「浏览器 sessionStorage」扩展为「服务端的分享记录」**，其余判题、解析、提示、
看答案、草稿、错题落库全部沿用现有链路。

两个必须一起做的配套：

1. **好友关系**（加好友需对方同意）——因为发题要指定收件人，而学生账号没有班级/学校字段，只能靠用户名精确匹配。
2. **学生端未读数**——学生端目前完全没有红点/轮询，B 不会知道有人发题。用 30s 轮询（家长端同款），不引入 WebSocket。

---

## 2. 范围

### P1（本期）

- 好友：精确用户名查找 → 申请 → 对方同意 → 双向好友；解除好友。
- 发题：结果页批量分享、错题本单题分享；收件箱；未读红点；打开即做。
- 家长端：孩子的好友列表（只读）+ 解除好友 + 近 20 条收发摘要。
- 家长建号页补一行说明：用户名会用于同学之间添加好友。

### P2（下期，本设计只留接口位）

- 好友之间互看**段位 + 累计积分**（数据已在 `student_points` / `levels.ts`，只缺受控只读端点与资料页）。
- 入口选择页「训练」卡片角标（P1 只有训练首页 Banner 与常驻入口）。

### 明确不做

| 不做 | 理由 |
|---|---|
| 站内聊天 / 分享留言 | 一旦有自由文本就变成未成年人私信通道，需要内容审核，本期不碰 |
| 模糊搜索学生 / 「可能认识的人」推荐 | 用户名可能就是真名，模糊搜索等于开放式找人 |
| 好友排行榜 / 班级群组 | 需要班级字段与新的可见性模型；先验证「发题」是否真被用 |
| 题目内容快照 | 分享只存 `question_id`，点开时实时读库；代价见 §9.1 |
| 跨服务器分享 | 部署是集中式，不做联邦 |
| 分享刷分 | 分享完成不发任何分（§8.3） |

---

## 3. 与既有约束的冲突与裁决

| # | 现状 | 冲突 | 裁决 |
|---|---|---|---|
| C1 | PRD §11：「学生学习数据仅家长可见」 | 「好友可见段位/积分」直接违反 | **P1 不暴露任何学习数据**给好友（只暴露姓名/年级），所以 P1 不违反；P2 落地前必须先改 PRD。本设计在 §12 列出 PRD 需新增/修订的原文 |
| C2 | `students` 无昵称/学校/班级/学号（`schema.sql:27-45`） | 无法按班级找人 | 只能**用户名精确匹配**；搜索接口只返回完全相等的一条，不返回候选列表 |
| C3 | 学生端无站内信/未读/轮询 | B 不知道有题 | 新增 `GET /api/student/shares/unread-count`，30s 轮询；不用 WebSocket（CLAUDE.md 硬规则） |
| C4 | 全局 `SubscriptionGuard` 默认锁全部学生端点 | 过期学生打不开收件箱 | **不做豁免**：过期学生本就被锁到 `/student/locked`，收件箱不可达是既有全局行为，不需要额外文案 |
| C5 | `POST /api/training/judge` 对 `source='freeform'` 的题返回 400/1001 | 自由做题原题分享了也做不了 | 发送时**拒绝** `source='freeform'` 的题（前端置灰 + 后端 400） |
| C6 | `questions.id` 自增，且判题端点本来就接受任意 `questionId`（无归属校验） | 「用 shareId 隐藏题号」不成立 | **不承诺隐藏题号**。分享用 `shareId` 是为了授权（只能打开发给自己的分享），不是为了保密。题面在题库里本来就是公开内容，本设计不扩大暴露面 |
| C7 | `students.avatar_url` 列存在但全仓未使用（`students.repo.ts` 未映射） | 好友列表没有头像 | 用「姓名首字」圆形文字（与 `UserBadge.tsx` 同款），不启用 `avatar_url` |
| C8 | 家长端所有学生维度接口都过 `requireOwnedStudent` | 家长看好友容易越权 | 家长端两个端点一律先 `requireOwnedStudent(studentId)`（`parent.service.ts:284`） |
| C9 | 自由做题已立「不同学生同题不应看到彼此照片」（freeform spec:60） | 分享题带材料图 | 分享的题面/材料来自题库公共资源（`questions.material_text/material_url`），不涉及学生上传原图；`freeform` 来源题已按 C5 拒绝 |

---

## 4. 用户流程

### 4.1 A 发题

```
结果页 / 错题本 → 点「发给同学」
  → 弹窗：好友列表（多选）+ 「本次 3 道数学题」
  → 发送成功 → toast「已发给 2 位同学」
```

约束：一次只允许**同一学科**的题；一次 1..20 道；发给的每个好友各生成一条分享记录。

### 4.2 B 收题

```
登录 → 训练首页看到 Banner「小明发来 3 道数学题」
  → 点进收件箱 / 直接点 Banner
  → 点「开始做题」→ 现有专项运行页（题单 3 道）
  → 逐题作答 → 结果页（无积分彩带）
  → 答错的题已进错题本（判题链路自动写入）
```

### 4.3 加好友

```
A：个人中心 → 好友 →「添加同学」→ 输入完整用户名 → 查到 1 人（username + 年级）
  → 发送申请
B：训练首页 Banner「小李申请加你为好友」/ 收件箱 → 同意
  → 双方互为好友（双向两行）
```

### 4.4 家长

```
家长端 → 孩子管理 → 某个孩子 →「好友」
  → 好友列表（姓名/年级/成为好友时间）+ 最近收发摘要
  → 「解除」→ 二次确认 → 双方关系删除（已发出的题不回收）
```

---

## 5. 页面与入口

训练轨页面规则沿用既有约定：全屏、写死 `data-theme="student-day"`、不在任何 Layout 下。

| 位置 | 路由 / 文件 | 内容 | 复用 |
|---|---|---|---|
| 训练首页 Banner | `/student/training`（`TrainingHomePage.tsx`） | 有待办时一条：`小明发来 3 道数学题` / `小李申请加你为好友`；可关闭（本次会话内） | `Banner`（已有，补偿套题同款） |
| 训练首页常驻入口 | 同上，三卡区域下方一行「收件箱」 | 无待办时也能进；有待办时显示未读数 | 纯 Link |
| 收件箱 | 新增 `/student/shares`（`SharesPage.tsx`） | 两个分组：**收到的题**、**好友申请**。分页 20 | `Card` / `Button` / `Modal` / `toast` |
| 答题 | `/student/training/targeted/run?subjectId=&returnTo=/student/shares` | 复用运行器 | `TargetedRunPage`（只加 `mode='shared'`） |
| 分享弹窗 | `components/business/ShareToFriendModal.tsx` | 好友多选 + 题数说明 + 发送 | `Modal` + 好友列表 |
| 分享入口 | ①运行器结果态 ②考试结果页（`ExamResultPage`） ③错题本行（`ErrorBookPage`） | ①「发给同学」按钮（整份题单）②同 ③单题图标 | 不新增页面 |
| 好友列表 | `/student/profile`（`ProfilePage.tsx`） | 好友条目 + 解除 + 「添加同学」；**好友名单只在这一处**，收件箱只管申请 | 与段位卡同页 |
| 家长端 | `/parent/students`（`ParentStudentsPage.tsx`）孩子卡片 →「好友」抽屉 | 好友列表 + 解除 + 收发摘要 | 不新增路由 |
| 家长建号 | 同上页面的建号表单 | 用户名输入框下加一行：`用户名用于同学之间添加好友，会显示给对方` | 一行静态文案 |

> 错题本存在 `question_id IS NULL` 的孤儿行（`main_error_books.question_id` 可空）。这些行的分享入口**禁用**，不发请求。

---

## 6. 数据模型

新增 4 张表。迁移 `tools/db/migrations/2026-11-28_student_sharing.sql`（`CREATE TABLE IF NOT EXISTS`，幂等），
并**折回** `tools/db/schema.sql`；DDL 批次收尾跑 `python3 tools/db/schema_reconcile.py`。

```sql
-- 好友申请：一条申请一行，状态机 pending -> accepted | rejected | cancelled
CREATE TABLE IF NOT EXISTS student_friend_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  from_student_id BIGINT NOT NULL,
  to_student_id   BIGINT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',   -- pending|accepted|rejected|cancelled
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  responded_at DATETIME(3) DEFAULT NULL,
  KEY idx_sfr_to (to_student_id, status, created_at),
  KEY idx_sfr_from (from_student_id, status, created_at),
  KEY idx_sfr_pair (from_student_id, to_student_id, status),
  CONSTRAINT fk_sfr_from FOREIGN KEY (from_student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_sfr_to   FOREIGN KEY (to_student_id)   REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 好友关系：**双向各一行**（查询不用 OR / UNION）
CREATE TABLE IF NOT EXISTS student_friends (
  student_id BIGINT NOT NULL,
  friend_id  BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (student_id, friend_id),
  KEY idx_sf_friend (friend_id),
  CONSTRAINT fk_sf_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_sf_friend  FOREIGN KEY (friend_id)  REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 分享：一次发送给一个人 = 一条；题在子表
CREATE TABLE IF NOT EXISTS question_shares (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  from_student_id BIGINT NOT NULL,
  to_student_id   BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  question_count SMALLINT NOT NULL,
  opened_at    DATETIME(3) DEFAULT NULL,   -- 首次打开（B 点「开始做题」）
  completed_at DATETIME(3) DEFAULT NULL,   -- 末题答完（仅度量，不发分）
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_qs_to (to_student_id, created_at),
  KEY idx_qs_from (from_student_id, created_at),
  CONSTRAINT fk_qs_from FOREIGN KEY (from_student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_qs_to   FOREIGN KEY (to_student_id)   REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_qs_subject FOREIGN KEY (subject_id) REFERENCES subjects (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS question_share_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  share_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  sort_order SMALLINT NOT NULL,
  UNIQUE KEY uniq_qsi_share_question (share_id, question_id),
  KEY idx_qsi_question (question_id),
  CONSTRAINT fk_qsi_share FOREIGN KEY (share_id) REFERENCES question_shares (id) ON DELETE CASCADE,
  CONSTRAINT fk_qsi_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

设计说明：

- **不存题面快照**。题目被改/下架后，分享按实时题面展示；`is_active=0` 的题在打开时跳过（§9.1）。
- **没有 `deleted_at`**。分享发出后不可撤回/不可删除；解除好友不影响已经发出的题单。
- **没有留言字段**（§2 不做），结构上就不给私信留口。
- **pending 唯一性靠应用层**：MySQL 无部分唯一索引；发申请在事务内 `SELECT ... FOR UPDATE` 检查
  「同方向是否已有 pending」，并发由行锁 + 唯一性二次校验兜住（表级只加普通索引）。
- **好友数上限 50、每日分享上限 30 份**（服务端常量，不落库）。

---

## 7. 接口契约

统一约定：响应经全局拦截器包装为 `{code:0, data}`，下文只写 `data`；时间字段 ISO 字符串；
错误码按 §2.4（1001 参数 / 1002 不存在 / 1003 无权 / 1004 拒绝 / 1008 限流 / 2001 订阅）。

### 7.1 学生端（`@Roles('student')`，`studentId` 一律取 JWT `sub`）

| # | 方法 | 路径 | 入参 | 成功 | 主要错误 |
|---|---|---|---|---|---|
| 1 | GET | `/api/student/friends` | — | `{friends:[{studentId,name,username,grade,schoolLevel,createdAt}]}` | — |
| 2 | GET | `/api/student/friends/search` | `username`（必填，1..50） | `{found:boolean,student?:{studentId,username,grade,schoolLevel,relation:'self'\|'none'\|'friend'\|'requested'\|'pending_in'}}` | 1001 |
| 3 | POST | `/api/student/friends/requests` | `{username}` | 201 `{requestId, merged:boolean}` | 1001 / 1002 / 1004 / 1008 |
| 4 | GET | `/api/student/friends/requests` | — | `{incoming:[...],outgoing:[...]}`（pending + 近 7 天已处理） | — |
| 5 | POST | `/api/student/friends/requests/:id/accept` | — | 200 `{friendId}` | 1002 / 1003 / 1004 |
| 6 | POST | `/api/student/friends/requests/:id/reject` | — | 200 `{ok:true}` | 1002 / 1003 / 1004 |
| 7 | DELETE | `/api/student/friends/:friendId` | — | 200 `{ok:true}` | 1002 |
| 8 | POST | `/api/student/shares` | `{toStudentIds:number[],questionIds:number[]}` | 201 `{shareIds:number[]}` | 1001 / 1002 / 1004 |
| 9 | GET | `/api/student/shares` | `box=inbox\|outbox`（缺省 inbox）、`page` | `{items:[...],page,pageSize:20,total}` | 1001 |
| 10 | GET | `/api/student/shares/unread-count` | — | `{shares:number,requests:number,total:number}` | — |
| 11 | POST | `/api/student/shares/:id/open` | — | 200 `{mode:'shared',subjectId,title,questions:TargetedPracticeQuestion[],share:{...}}` | 1002 / 1003 |
| 12 | POST | `/api/student/shares/:id/complete` | — | 200 `{ok:true}` | 1002 / 1003 |

> 路由顺序：#10 `unread-count` 必须声明在 #11 `:id` 之前，否则被 `ParseIntPipe` 吃成 400。

**#2 search 逐步逻辑**

1. `username` 去首尾空格；空/超长 → 1001。
2. `SELECT id, username, grade, school_level FROM students WHERE username=? AND is_active=1 AND deleted_at IS NULL LIMIT 1`。
3. 命中自己 → `found:true, relation:'self'`，前端禁用「发送申请」（后端 #3 也会拒）。
4. 不命中 → `{found:false}`（**不返回候选列表**，C2）。
5. `relation` 判定：已好友 → `friend`；我发过 pending → `requested`；对方发过 pending → `pending_in`。
6. **限流**：每学生 10 次/分钟（进程内计数，按 `sub`），超出 → 1008。

**#3 发申请逻辑**

1. 目标不存在/已停用/已注销 → 1002 `同学不存在`。
2. 目标是自己 → 1004。
3. 已是好友 → 1004 `你们已经是好友`。
4. 事务内查同方向 pending：有 → 1004 `申请已发送，等待对方同意`；反向 pending 存在 → 直接按 #5 的接受语义**反向合并**（对方已在等我，不该再产生第二条 pending）→ 返回 201 `{requestId: 对方的申请 id, merged: true}`。
5. 我好友数 ≥50 → 1004 `好友已达上限`。
6. INSERT pending，返回 201 `{requestId, merged:false}`。

**#5 接受逻辑**

1. 申请不存在 / `to_student_id !== sub` → 1002 / 1003。
2. `status !== 'pending'` → 1004 `该申请已处理`。
3. 事务内：`UPDATE ... SET status='accepted', responded_at=NOW(3) WHERE id=? AND status='pending'`；
   `rowsAffected=0` → 并发已处理 → 1004。
4. `INSERT IGNORE` 双向两行 `student_friends`。
5. 双方好友数都 ≥50 → 先回滚再 1004（避免单向成功）。

**#7 解除逻辑**：`DELETE FROM student_friends WHERE (student_id=? AND friend_id=?) OR (student_id=? AND friend_id=?)`（两行，一个事务）。
不存在 → 1002。不删申请历史、不删分享。

**#8 发送逻辑**

1. 参数：`toStudentIds` 去重后 1..20；`questionIds` 去重后 1..20；否则 1001。
2. `toStudentIds` 每个都必须是当前好友，否则 1004 `只能发给好友`。
3. 一次 `SELECT id, subject_id, source, is_active FROM questions WHERE id IN (...)`：
   - 缺任何 id / `is_active=0` → 1002 `题目已下架`；
   - 任意 `source='freeform'` → 1004 `自由做题的题不能发给同学`（C5）；
   - `subject_id` 不唯一 → 1001 `一次只能发同一学科的题`。
4. 频率：当日（自然日，DB 时区）该生已发 ≥30 **份**（发给 5 个好友算 5 份）→ 1004 `今天发得太多了`。
5. 事务：按 `toStudentIds` 逐人 INSERT `question_shares` + 逐题 INSERT items（`sort_order` = 入参数组顺序）。
6. 接收方**不做实时推送**，靠 30s 轮询。

**#9 列表**：`box=inbox` 过滤 `to_student_id=sub`，`outbox` 过滤 `from_student_id=sub`，按 `created_at DESC`。
条目形状：

```json
{
  "shareId": 12,
  "from": {"studentId": 7, "name": "小明", "grade": "七年级"},
  "to":   {"studentId": 8, "name": "小华", "grade": "七年级"},
  "subjectId": 2, "subjectName": "数学",
  "questionCount": 3,
  "opened": false, "completed": false, "createdAt": "2026-11-28T10:00:00.000Z"
}
```

inbox 条目不返回 `questionIds`（题面只在 #11 返回），outbox 条目也不返回（避免家长端/前端拿题号批量拉解析）。

**#11 打开逻辑**

1. 查 `question_shares`：不存在 → 1002；`to_student_id !== sub` → 1003。两种情况都**不返回发送者信息**。
2. 读 items 的 `question_id`（按 `sort_order`），一次 `SELECT` 题目（`is_active=1`）。
3. 映射为 `TargetedPracticeQuestion`（复用 `HistoryPracticeService.toRunQuestion` 的字段集，见 §8.2）。
4. 有效题 0 道 → 1002 `这些题已下架`（前端弹 toast 留在列表）。
5. `opened_at IS NULL` 时补写（`UPDATE ... SET opened_at=NOW(3) WHERE id=? AND opened_at IS NULL`）。
6. 返回 `{mode:'shared', subjectId, title:`${发送者姓名} 发来的 ${n} 道${学科名}题`, questions, share:{shareId,questionCount,createdAt}}`。

**#12 完成**：只写 `completed_at`（幂等：非空直接返回 `{ok:true}`）。归属校验同 #11。**不发分、不建会话、不写练习记录**。

### 7.2 家长端（`@Roles('parent')`，先 `requireOwnedStudent`）

| # | 方法 | 路径 | 成功 | 错误 |
|---|---|---|---|---|
| 13 | GET | `/api/parent/students/:studentId/friends` | `{friends:[...], shares:{sent:number,received:number,recent:[...]}}` | 1002 / 1005 |
| 14 | DELETE | `/api/parent/students/:studentId/friends/:friendId` | 200 `{ok:true}` | 1002 / 1005 |

- #13 的 `shares.sent/received` 是**近 30 天**计数；`recent` 只给**摘要**：`{direction:'sent'|'received', peer:{name,grade}, questionCount, subjectName, createdAt, opened}`，最多 20 条，**不含题目内容、不含留言（本来也没有）**。
- #14 与 #7 同一服务方法，区别只是归属校验走家长。

### 7.3 通用口径

- **分页**：服务端固定 `pageSize=20`；`page` 缺省 1，超出总页数返回空数组（不报错）。
- **限流**：只用两处——搜索 10 次/分、发送 30 份/日；进程内计数，重启清零（单机集中部署可接受，与 `SessionRegistry` 同款假设）。
- **不发事件埋点**：不新增 `behavior_events` 事件类型（`EVENT_TIER` 不动），度量只用 `question_shares` 自身两列（§13）。

---

## 8. 运行页复用（前端改动清单）

### 8.1 交接体

`run-handoff.ts`：

```ts
mode?: 'similar' | 'redo' | 'shared';
```

`parseRunHandoff` 的 mode 白名单加 `'shared'`；形状校验的其余分支不变（`sessionId` 必须显式 `number|null`）。

### 8.2 题单字段映射

分享题单必须与专项**同形**（`TargetedPracticeQuestion`，`api.ts:1555-1572`），复用
`HistoryPracticeService.toRunQuestion` 的字段集（`questionId/text/type/options/materialText/materialUrl/subNo/materialPosition/source/questionNo`）。
实施时把该私有方法提升为模块内可复用的纯函数（或在 `questions.repo` 增加按 id 批量取同列的方法），
**禁止在 social 模块另写一份映射**——否则材料位置、小问序号、选项归一化会与专项漂移。

### 8.3 `TargetedRunPage` 改动点

| 位置 | 改动 |
|---|---|
| `mode` 类型与初值 | `'similar' \| 'redo' \| 'shared'`，缺省仍 `similar` |
| 判题参数（第 387 行） | `...(mode === 'redo' ? {} : { sessionUid })` → **改为仅 `similar` 带 `sessionUid`**；`shared` 与 `redo` 同口径不写 `special_answer_records` |
| `handleFinish`（第 242 行） | `if (mode !== 'redo')` → `if (mode === 'similar')`；新增 `if (mode === 'shared' && shareId) completeShareRun(shareId).catch(() => {})` |
| 发分 hook | `sessionId` 恒 `null`（`shared`）→ `useSessionPointsCompletion` 自动跳过，不改 hook |
| 退出目标 | `returnTo` 白名单加 `^/student/shares$`；缺省仍回专项配置页 |
| 标题 | `runTitle` 用 #11 返回的 `title` |
| 结果页 | 不显示任何积分相关元素（无彩带、无「本次不发分」说明——按「只显示有作用的信息」） |

`shareId` 从哪来：`/student/shares` 页点「开始做题」时，把 `shareId` 一并写进交接体（`mode:'shared'` 时必填）。
交接体形状扩展为 `{sessionId:null, questions, title, mode:'shared', shareId:number}`，`parseRunHandoff` 对 `shareId` 做
`number?` 校验（`mode==='shared'` 且缺失 → 视为形状不对，走空题单回退）。

### 8.4 分享入口的行为

| 入口 | 题单来源 | 学科 |
|---|---|---|
| 运行器结果态 | 本次运行的 `questions[].questionId`（跳过 `null`） | 本次 `subjectId` |
| 考试结果页 | 该会话的题目 id | 该卷学科 |
| 错题本行 | 该行 `question_id`（`null` 禁用） | 该行学科 |

三处共用 `ShareToFriendModal`。若好友为空 → 弹窗内显示「还没有好友」+「添加同学」按钮，不发请求。

---

## 9. 边界与异常

### 9.1 题目变化

- 打开时逐题过滤 `is_active=1`；部分失效 → 只出有效题，标题按有效题数重算（`title` 在服务端生成）。
- 全部失效 → 1002，前端 toast + 停留列表。
- 题干被改：直接显示新题面（不快照，见 §6）。
- `source='freeform'` 的题：发送时拒绝（C5），历史脏数据在打开时亦跳过。

### 9.2 关系变化

- 解除好友后：已发出的分享**仍可打开**（数据已投递），但不能再发新题；收件箱里保留历史。
- 解除好友不删申请历史（申请记录只做状态留痕，不参与好友判定）。
- 对方账号停用/删除：`ON DELETE CASCADE` 清掉关系与分享；列表查询 JOIN `students` 时过滤 `is_active=1`。

### 9.3 并发与重复

- 同一对好友互相同时申请 → 后提交的一条按 §7.1 #3 第 4 步合并为接受（不产生两条 pending）。
- 同时接受同一条申请 → `UPDATE ... AND status='pending'` 影响行数判定，第二人拿 1004。
- 重复发送同题给同一人 → 允许（两条独立分享），不做去重（学生可能想再提醒一次）。

### 9.4 订阅与登录

- B 订阅过期：所有 `/api/student/*` 被 `SubscriptionGuard` 拦成 403/2001 → 前端既有逻辑跳锁定页；**收件箱不需要特判**。
- 单点登录：分享不共享登录态，B 必须自己登录（互踢码 1013 与本期无关）。

### 9.5 已知体验缺口（P1 接受）

- 发给 B 的题里，B 已经做过的题不会提示「已做过」——需要联查作答记录，本期不做。
- 学生端红点只在训练首页可见；不常进训练轨的学生可能延迟发现（P2 再考虑入口页角标）。

---

## 10. 隐私

**对好友可见**：`name`（家长填写的孩子姓名，为空回退 `username`）、`username`、`grade`。**不可见**：积分、段位、错题、正确率、学习时长、任何 `behavior_events`。

**搜索返回**：只返回 `username` + `grade` + 关系状态，不返回 `name`（成为好友后才显示姓名）。

**家长可见**：好友名单、成为好友时间、收发摘要（对方、学科、题数、时间、是否打开）。不可见题目内容（题面属于公共题库，无需家长审）。

**知情**：家长建号页用户名输入框下增加一行说明（§5）。不在注册流程新增勾选（既有流程无监护人勾选，本期不扩大改动面）。

**最小化**：不新增自由文本、不上传头像、不记录打开设备/IP（除既有请求日志）。

---

## 11. 测试

后端（vitest，`apps/server/src/modules/social/*.test.ts`）：

1. 搜索：命中/未命中/命中自己/停用账号/超长入参/限流 1008。
2. 申请：重复 pending → 1004；反向 pending → 合并为接受；好友数满 → 1004；已是好友 → 1004。
3. 接受：非本人 → 1003；非 pending → 1004；并发第二次 → 1004；成功后 `student_friends` 恰好两行。
4. 解除：删两行；不存在 → 1002；不删分享。
5. 发送：非好友 → 1004；跨学科 → 1001；`freeform` → 1004；`is_active=0` → 1002；超 20 题 → 1001；日限 30 → 1004；多人发送生成多条 share。
6. 打开：别人的 share → 1003；部分下架只返回有效题且 `title` 重算；全部下架 → 1002；首开写 `opened_at`，二次打开不改。
7. 完成：幂等；不写 `point_ledger`、不写 `training_sessions`、不写 `special_practice_sessions`（断言三张表行数不变）。
8. 家长端：非本人孩子 → 1005；解除走同一服务。
9. 护栏：`SUBSCRIPTION_EXEMPT` 长度与内容断言不变（`subscription.guard.test.ts` 现成）；`parent-analytics.privacy-guard.test.ts` 不改。

前端（`@testing-library/react`，注意 `globals:false` 需自带 `afterEach(cleanup)`）：

10. `parseRunHandoff`：`mode='shared'` 且带 `shareId` 通过；缺 `shareId` → `null`；`mode` 非法 → `null`。
11. `ShareToFriendModal`：无好友显示空态且不发请求；多选计数正确；发送中禁用重复提交。
12. `SharesPage`：空态、两个分组、未读条目高亮、点击「开始做题」写入交接体并导航（断言 `sessionStorage` 内容与 URL）。
13. `TargetedRunPage`（shared）：结果态不渲染积分元素；`handleFinish` 调 `completeShareRun` 一次；不调 `completeSpecialSession`。

手工冒烟（一条链路）：A 建号 → 加 B → B 同意 → A 从结果页发 3 题 → B 训练首页看到 Banner → 做题 → 答错 1 题 → B 错题本出现该题 → 家长端看到好友与摘要 → 家长解除 → A 不能再发。

---

## 12. 文档同步（实现时同批提交）

| 文档 | 动作 |
|---|---|
| `docs/K12智学系统-产品需求文档.md` | 新增 §7.16「学生好友与发给同学」：流程、上限、家长可见范围、可见字段白名单、P2 段位互看标注「需先修订 §11」 |
| 同上 §11 数据隐私 | 原文「学生学习数据仅家长可见」改为：「学习明细数据仅家长可见；学生之间仅可见姓名/年级，**P2 起**增加段位与累计积分，且需双方同意、家长可解除」 |
| `docs/API接口与数据流设计文档.md` | 新增 §4.32 StudentSocial（14 端点）+ §5.34 数据流（发题 → 收件箱 → 运行器 → 错题本）；§2.4 补一条实现注：1008 复用为通用限流（搜索/日发送上限） |
| `docs/api/openapi.yaml` | 同步 14 个 operation（POST 发申请/发分享记 201；accept/reject/open/complete 显式 `@HttpCode(200)`）+ 6 schema |
| `docs/K12智学系统-数据库设计文档.md` | 新增 §3.24 四张表 |
| `docs/UX-UI设计文档.md` | §5 新增「收件箱」页与「发给同学」弹窗规范（含空态、未读、家长抽屉） |
| `docs/constraints/专项子系统.md` 或新建 `docs/constraints/社交与分享.md` | 记录三条勿动：不新增 `judge source`、不豁免订阅、不发分/不建会话 |

---

## 13. 度量与去留判据

`question_shares` 两列即可算全链路：

```sql
SELECT COUNT(*)                                        AS sent,
       SUM(opened_at    IS NOT NULL)                    AS opened,
       SUM(completed_at IS NOT NULL)                    AS completed,
       COUNT(DISTINCT from_student_id)                   AS senders,
       COUNT(DISTINCT to_student_id)                     AS receivers
FROM question_shares
WHERE created_at >= ?;
```

**上线两周判据**（与用户约定的「先验证再投入」）：

| 指标 | 阈值 | 不达标怎么办 |
|---|---|---|
| 发起分享的学生数 | ≥10 | 入口不对或需求不真 → 不加 P2，回收入口 |
| 打开率（opened/sent） | ≥50% | 朋友关系是虚的 → 改做「口令/链接」交付（无需好友） |
| 打开后完成率（completed/opened） | ≥60% | 题不对味 → 只保留「同班/同年级」过滤，或砍掉功能 |

低使用率时**不保留半成品**：下线入口与 Banner，保留表（不删数据）。

---

## 14. 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 变成社交攀比/骚扰 | 家长投诉 | 双方同意 + 家长可解除 + 好友上限 50 + 无留言；P2 段位互看前再审一次 |
| 用户名是真名 | 身份暴露 | 搜索只精确匹配、只回 username+年级；家长建号页补说明 |
| 学生拿分享当「要答案」的通道 | 抄答案 | 分享只给题面，不给答案；判题/解析本来对本人可见，不新增泄漏 |
| 家长端看到错题来源不是「同学发的」 | 学情归因不清 | 裁决：不新增 `source` 枚举（避免污染既有筛选与统计）；家长端可见「好友收发摘要」作为补充 |
| 轮询增加负载 | 每小时每生 120 次请求 | 仅训练首页 + 收件箱页挂 30s；页面不可见时暂停（`document.visibilityState`） |

---

## 15. 实施顺序（交 writing-plans 拆任务）

1. **DB**：迁移 + `schema.sql` 折回 + 对账脚本。
2. **后端-好友**：repo + service + controller（7 端点）+ 单测。
3. **后端-分享**：repo + service + controller（5 端点）+ 单测 + 三张表不写入的断言。
4. **后端-家长**：2 端点 + 归属校验 + 单测。
5. **前端-公共**：`run-handoff` mode/shareId、`api.ts` 类型与 14 个方法（学生 12 + 家长 2）、`ShareToFriendModal`。
6. **前端-页面**：`SharesPage`、训练首页 Banner、个人中心好友区、三处分享入口、家长端抽屉、家长建号说明文案。
7. **运行页改造**：`TargetedRunPage` 六处改动（§8.3）+ 渲染测试。
8. **文档同步**：§12 表格逐项落地（PRD / API / openapi / DB / UX / constraints）。
9. **验收**：§11 手工冒烟一条链路。
