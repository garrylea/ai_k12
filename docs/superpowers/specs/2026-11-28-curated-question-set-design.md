# 学生精选题单推荐与年级发布设计

**日期**：2026-11-28
**状态**：v1.1 已按 review 修订，待用户复核后进入实施计划
**取代**：`docs/superpowers/specs/2026-11-28-student-sharing-design.md` 中的学生好友与互发方案

## 1. 结论

本期不再建设学生好友、学生互发、通用学生消息或通用收件箱。

最终产品闭环为：

```text
学生觉得一组题不错
  → 点「推荐这套题」
  → 精选题单进入教研员审核
  → 教研员填写标题并选择一个目标年级后发布
  → 对应年级学生在个人中心看到题单
  → 打开现有题单运行器作答
  → 记录普通练习历史，但不发积分
```

精选题单是**内容分发**，不是社交消息。它不产生学生之间的身份、关系、聊天或自由文本。

## 2. 范围

### 2.1 P1

- 学生从专项练习结果页和错题本单题行推荐题集。
- 推荐按题目集合聚合并进入教研员审核队列。
- 教研员可拒绝、按单个年级发布、撤回某次发布。
- 同一题集可分别发布到多个年级；每个 publication 只对应一个年级。
- 个人中心展示精选题单完整列表和未读状态。
- 训练首页保留条件式未读 Banner，作为发现提示。
- 精选题单复用 `TargetedRunPage`，记录练习历史，不发积分。

### 2.2 明确不做

| 不做 | 原因 |
|---|---|
| 学生好友、好友申请、互发题单 | 会引入无效社交、身份暴露和关系治理 |
| 学生私信、留言、推荐理由 | 首期不需要自由文本，避免内容审核通道 |
| 通用学生消息中心 | 本期只有精选题单一种消息形态 |
| 管理员参与审核 | 内容判断归教研员，管理员不进入该流程 |
| 按学段发布 | 用户裁决首期只按具体年级发布 |
| 模糊年级匹配 | 使用标准 `grade_N` 编码，避免历史年级写法导致漏投 |
| 题目内容快照 | 发布只保存题目 ID，打开时读取当前在架题面 |
| 分享积分任务 | 精选题单只记学习历史，不创建积分会话 |
| 考试结果页整卷推荐 | 试卷可能超过 20 题，接入会额外引入选题弹窗 |
| 30 秒消息轮询 | 内容低频，进入页面和窗口重新聚焦时刷新即可 |

## 3. 用户流程

### 3.1 学生推荐

```text
专项结果页 / 错题本单题
  → 点「推荐这套题」
  → 成功提示「已推荐给教研员」
  → 按钮变为「已推荐」
```

推荐约束：

- 同一学科；
- 去重后 1～20 道题；
- 题目在架且存在非空标准答案；
- 不接收 `source='freeform'` 的题；
- 推荐的每道题都必须能在该生已有的作答事实中找到记录；不能把任意未做过的题临时拼成题集；
- 同一学生、同一题集只记一次推荐；
- 每名学生每自然日最多产生 10 个新题集推荐，重复推荐同一题集不占额度；
- 同一学生重复点击返回幂等结果，不新增推荐行。

### 3.2 教研员审核与发布

```text
教研空间 → 精选题单
  → 待审核列表
  → 查看题目、推荐次数、推荐年级分布
  → 填写标题并选择一个年级发布
```

发布规则：

- 标题 1～60 字；
- 每次发布只选择一个标准年级；
- 同一题集再次发布到其它年级时新增一个 publication；
- 第一次发布成功即视为审核通过；
- 拒绝后该题集不会自动重新进入待审核，后续推荐只增加推荐信号；
- 已发布列表可按年级逐项撤回。

### 3.3 学生查看与作答

```text
个人中心 → 精选题单
  → 点击题单
  → 标记该 publication 已读
  → 现有 TargetedRunPage
  → 结果页
  → 返回个人中心
```

训练首页仅在有未读题单时显示 Banner：

- 展示最新一条或聚合后的未读数量；
- 本次页面会话内可关闭；
- 点击「查看」进入个人中心，不直接开始做题；
- 不增加训练首页常驻入口；
- 不做定时轮询，只在页面挂载和窗口重新聚焦时刷新。

## 4. 数据模型

新增 5 张表。迁移文件为 `tools/db/migrations/2026-11-28_curated_question_sets.sql`，幂等执行，并折回 `tools/db/schema.sql`。

### 4.1 `featured_question_sets`

题集主体和审核状态。

```sql
CREATE TABLE IF NOT EXISTS featured_question_sets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  content_key CHAR(64) NOT NULL COMMENT 'sha256(subject_id + 排序去重后的 questionIds)',
  subject_id BIGINT NOT NULL,
  review_status VARCHAR(16) NOT NULL DEFAULT 'pending'
    COMMENT 'pending|approved|rejected',
  question_count SMALLINT NOT NULL,
  reviewed_by BIGINT DEFAULT NULL COMMENT 'admins.id, role=researcher',
  reviewed_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_fqs_content_key (content_key),
  KEY idx_fqs_review (review_status, created_at),
  CONSTRAINT fk_fqs_subject FOREIGN KEY (subject_id) REFERENCES subjects (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_fqs_reviewer FOREIGN KEY (reviewed_by) REFERENCES admins (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

约束：

- `question_count` 为 1～20；
- 不对 `reviewed_by` 做数据库角色校验，服务端必须确认其角色为 `researcher`。

### 4.2 `featured_question_set_items`

```sql
CREATE TABLE IF NOT EXISTS featured_question_set_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  sort_order SMALLINT NOT NULL,
  UNIQUE KEY uniq_fqsi_set_question (set_id, question_id),
  UNIQUE KEY uniq_fqsi_set_order (set_id, sort_order),
  KEY idx_fqsi_question (question_id),
  CONSTRAINT fk_fqsi_set FOREIGN KEY (set_id)
    REFERENCES featured_question_sets (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsi_question FOREIGN KEY (question_id)
    REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`featured_question_set_items` 必须加入教研删卷的 `BLOCKING_TABLES`，否则影响预览会显示可删、实际删除却被外键阻断。

### 4.3 `featured_question_set_recommendations`

```sql
CREATE TABLE IF NOT EXISTS featured_question_set_recommendations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL,
  student_grade_code VARCHAR(10) NOT NULL COMMENT '推荐时年级快照，如 grade_7',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_fqsr_set_student (set_id, student_id),
  KEY idx_fqsr_set_grade (set_id, student_grade_code),
  CONSTRAINT fk_fqsr_set FOREIGN KEY (set_id)
    REFERENCES featured_question_sets (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsr_student FOREIGN KEY (student_id)
    REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

审核页只展示人数和年级分布，不展示学生姓名或用户名。

### 4.4 `featured_question_set_publications`

一次发布 = 一个年级 = 一个学生收件项。

```sql
CREATE TABLE IF NOT EXISTS featured_question_set_publications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id BIGINT NOT NULL,
  grade_code VARCHAR(10) NOT NULL,
  title VARCHAR(60) NOT NULL COMMENT '每个年级独立标题',
  reach_count INT NOT NULL COMMENT '发布时该年级有效学生数快照',
  status VARCHAR(16) NOT NULL DEFAULT 'published'
    COMMENT 'published|withdrawn',
  published_by BIGINT NOT NULL COMMENT 'admins.id, role=researcher',
  published_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  withdrawn_by BIGINT DEFAULT NULL,
  withdrawn_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_fqsp_set_grade (set_id, grade_code),
  KEY idx_fqsp_grade_status (grade_code, status, published_at),
  CONSTRAINT fk_fqsp_set FOREIGN KEY (set_id)
    REFERENCES featured_question_sets (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsp_publisher FOREIGN KEY (published_by) REFERENCES admins (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_fqsp_withdrawer FOREIGN KEY (withdrawn_by) REFERENCES admins (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

标题属于 publication，不允许同一题集发到七年级和八年级时互相覆盖标题。发布时按当前有效学生数写 `reach_count` 快照。

同一题集同一真实年级只有一个 publication。撤回后若再次发布，复用该行、替换标题和 `reach_count`、恢复 `published`、清空撤回字段并刷新 `published_at`；同时删除该 publication 的旧 read 行，让重新发布形成一次新的未读投递。

### 4.5 `featured_question_set_reads`

```sql
CREATE TABLE IF NOT EXISTS featured_question_set_reads (
  publication_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL,
  read_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (publication_id, student_id),
  KEY idx_fqsr_student (student_id, read_at),
  CONSTRAINT fk_fqsread_publication FOREIGN KEY (publication_id)
    REFERENCES featured_question_set_publications (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsread_student FOREIGN KEY (student_id)
    REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 4.6 `special_practice_sessions` 增量列

精选题单仍写现有专项历史，但需要建立“这次作答属于哪次发布”的服务端凭据：

```sql
ALTER TABLE special_practice_sessions
  ADD COLUMN featured_publication_id BIGINT DEFAULT NULL
    COMMENT '非空=精选题单作答；用于服务端强制不发错误订正分与度量',
  ADD KEY idx_sps_featured_publication (featured_publication_id);
```

随后增加外键引用 `featured_question_set_publications(id) ON DELETE SET NULL`。该列非空时，普通判题/自评服务必须从服务端强制压制 `error_fix`，不信任客户端布尔值。

以上 `ALTER TABLE` 只是字段示意。迁移必须兼容现有 MySQL 版本并按 `information_schema` 判断列/索引/外键是否已存在，保持可重复执行。

## 5. 内容去重与年级

- 题目集合先按题目 ID 去重，再按输入顺序保留 `sort_order`。
- `content_key` 使用**排序后的题目 ID 集合**计算，因此不同推荐顺序仍归入同一题集。
- 计算内容：`sha256(String(subjectId) + ':' + sortedQuestionIds.join(','))`。
- 年级统一使用 `apps/server/src/common/utils/grade.ts` 的 `grade_N` code，不使用 `students.grade` 原始标签。
- 读取时先 `resolveGradeInfo(student.grade)?.code`，解析失败则不匹配任何年级精选。
- 首次推荐创建题集必须在一个事务内完成：按 `content_key` 执行幂等 upsert，写 items，再写 recommendation；并发命中同一 `content_key` 时复用已提交/已加锁的题集，不产生半套 items。

## 6. 接口

### 6.1 学生

所有端点 `@Roles('student')`，`studentId` 从 JWT `sub` 获取。

| # | 方法 | 路径 | 入参 / 输出 |
|---|---|---|---|
| 1 | POST | `/api/student/featured-sets/recommend` | 入参 `{questionIds:number[]}`；成功 201 `{setId,alreadyRecommended:boolean}` |
| 2 | GET | `/api/student/featured-sets?page=1` | `{items,page,pageSize:20,total}` |
| 3 | GET | `/api/student/featured-sets/unread-count` | `{count:number}` |
| 4 | POST | `/api/student/featured-sets/publications/:id/open` | 创建服务端作答会话、幂等标已读并返回题单交接数据；显式 `@HttpCode(200)` |

学生列表项：

```json
{
  "publicationId": 12,
  "setId": 7,
  "title": "七年级数学期末高频错题",
  "subjectId": 1,
  "subjectName": "数学",
  "questionCount": 8,
  "publishedAt": "2026-11-28T10:00:00.000Z",
  "isRead": false
}
```

`questionCount` 是当前在架且可展示题数。没有在架题的 publication 不出现在学生列表和未读数中。

`open` 返回：

```json
{
  "mode": "featured",
  "sessionUid": "9b92...",
  "subjectId": 1,
  "title": "七年级数学期末高频错题",
  "questions": ["TargetedPracticeQuestion"]
}
```

`open` 必须在一个事务内：

1. 锁 publication；
2. 校验 `status='published'`；
3. 校验学生当前 `grade_N` 等于 `grade_code`；
4. 读取在架题；
5. 题目数为 0 时回 1002，不写 read；
6. 创建 `special_practice_sessions`，服务端生成 `session_uid`，写 `featured_publication_id`、标题和题数；
7. 会话创建失败则整个 open 失败，不允许返回一个无服务端凭据的精选题单；
8. 使用 `INSERT ... ON DUPLICATE KEY UPDATE read_at=read_at` 幂等写已读；
9. 返回完整运行载荷。

### 6.2 教研员

所有端点 `@Roles('researcher')`。

| # | 方法 | 路径 | 说明 |
|---|---|---|---|
| 5 | GET | `/api/research/featured-sets?status=&page=` | 审核列表，缺省 pending |
| 6 | GET | `/api/research/featured-sets/:id` | 题单详情、推荐人数、年级分布、publication 列表 |
| 7 | GET | `/api/research/featured-sets/pending-count` | 侧栏待审核角标 |
| 8 | POST | `/api/research/featured-sets/:id/publish` | `{title,gradeCode}`，标题写入该年级 publication |
| 9 | POST | `/api/research/featured-sets/:id/reject` | 拒绝 pending 题集 |
| 10 | POST | `/api/research/featured-sets/:id/reopen` | 将 rejected 题集重新置 pending |
| 11 | POST | `/api/research/featured-sets/publications/:id/withdraw` | 撤回一次发布 |

发布、拒绝、重新审核、撤回均为状态迁移 POST，显式 `@HttpCode(200)`。

`publish` 事务：

1. 锁题集；
2. `rejected` 禁止发布；
3. 校验标题、年级编码；
4. upsert publication，标题只写当前年级的 publication；
5. 题集置 `approved`，写 `reviewed_by/reviewed_at`；
6. 提交后返回 `{publicationId}`。

同一题集已 approved 时仍可追加其它年级的 publication，不重复改审核字段。

## 7. 运行器复用

### 7.1 交接体

```ts
mode?: 'similar' | 'redo' | 'featured';
```

`mode='featured'` 要求 `sessionId: null` 且交接体必须携带服务端 `open` 返回的 `sessionUid`。运行器不得为该模式自行生成新的 UUID，否则服务端无法识别“这是精选题单”。

### 7.2 作答历史与积分隔离

| 行为 | featured 口径 |
|---|---|
| `sessionUid` | 来自服务端 open；对应 session 已写 `featured_publication_id` |
| `sessionId` | 恒为 null |
| 训练积分完成 | 不调用 |
| 判题 source | 继续使用 `'targeted'`；不新增 `'featured'` judge source |
| 客观题判题 | 服务端按 `sessionUid` 查到 featured session 后强制压制 `error_fix`，客户端布尔值不能作为保证 |
| 主观题自评 | 服务端校验 session 归属；featured session 继续走无奖励的结算路径 |
| 错题清零 | 答对仍可清零，但不发 `error_fix` |
| 提示、解析、讨论、草稿 | 全部沿用 |
| 结果页积分元素 | 不渲染 |

题单历史仍复用现有专项历史体系。首期不新增 `special_practice_sessions.module` 新枚举；标题由服务端返回的精选标题决定，避免扩大判题、统计和家长端来源口径的改动面。

服务端强制规则：

- `TrainingService.judgeTraining` 在调用 `JudgeCore` 前按 `sessionUid + studentId` 查会话；
- 会话的 `featured_publication_id` 非空时，把 `suppressErrorFixPoints` 强制置 true，忽略客户端值；
- `selfAssess` 同样先校验 session 归属；featured session 不进入可发奖励的旧语义分支；
- 普通 targeted/error_practice 会话行为不变；
- 通用判题端点仍允许学生自行做普通题，这是既有能力，不是精选题单新增的旁路。

### 7.3 结果页与退出

- 末题完成后照常展示结果。
- 不显示积分彩带、段位或“本次不发分”说明。
- 完成后调用现有专项 session 完成接口，结束历史记录。
- `returnTo` 只允许 `/student/profile`。
- 刷新导致 sessionStorage 交接体丢失时回个人中心。

## 8. 页面

### 8.1 个人中心

`ProfilePage` 在标题下方、段位卡上方新增「精选题单」卡片：

- 无题单时仍显示入口和空态“暂无精选题单”；
- 有题单时展示未读数以及分页列表，每页 20；
- 列表项包含标题、学科、题数、发布时间和未读标记；
- 点击后进入运行器；
- 不使用独立浅停留 Tab，不新增个人中心侧栏或导航。

### 8.2 训练首页 Banner

`TrainingHomePage` 复用现有 `Banner`：

- 只在当前年级存在未读 publication 时出现；
- 放在现有相似题待办 Banner 之后；
- 多条未读聚合为“有 N 个新精选题单”，并显示最新标题；
- 按钮「查看」导航到 `/student/profile`；
- 本次页面会话内可关闭；
- 页面重新聚焦时重新获取，不使用固定定时器。

### 8.3 教研空间

- `ResearchNav` 增加「精选题单」。
- 侧栏读取 pending count 并显示待审核角标；挂载和窗口重新聚焦时刷新，不做固定轮询。
- 路由为 `/research/featured-sets`，详情可复用列表内展开或 `/research/featured-sets/:id`。
- 待审核列表展示学科、题数、推荐人数、年级分布、最早推荐时间。
- 详情只读展示全部题目，题目渲染复用共享 Markdown 配置。
- 发布弹窗包含标题、单一年级下拉和确认按钮。
- 已发布列表按 publication 展示，可按年级撤回。
- 已拒绝列表提供「重新审核」。

## 9. 隐私与权限

- 学生看不到推荐者身份。
- 教研员只看聚合人数与推荐时年级，不看姓名、用户名或其它学习数据。
- 家长端不新增精选题单入口；孩子完成的精选题单会出现在既有练习记录中。
- 不新增好友、消息、自由文本或上传字段。
- 不新增 `behavior_events` 事件；直接使用推荐、发布、已读和练习历史数据度量。
- `SubscriptionGuard` 不新增豁免。

**PRD 冲突裁决 C1**：PRD §11 当前写“学生学习数据仅家长可见”。本设计不向教研员暴露姓名、答案、正确率或错题，只暴露“推荐时年级的聚合人数”，用于决定发布年级。实施时必须同步修订 PRD 为“学习明细仅家长可见；教研员可看推荐票的年级聚合，不可反查到个人”，并补隐私守卫测试。若不愿开放该聚合口径，则删除年级分布，教研员自行选择年级。

## 10. 异常处理

| 场景 | 结果 |
|---|---|
| 推荐题目为空、超过 20、含非法 ID | 1001 |
| 当日新题集推荐数已达 10 | 1008 |
| 推荐跨学科 | 1001 |
| 任意题不存在或已下架 | 1002 |
| 任意题无标准答案 | 1004 |
| 任意题为 freeform | 1004 |
| 任意题未出现在该生作答事实中 | 1004 |
| 同一学生重复推荐同一题集 | 200 幂等，`alreadyRecommended=true` |
| 已拒绝题集新增推荐 | 记录推荐，但不自动恢复 pending；教研员可手动重新审核 |
| 学生当前年级与 publication 不一致 | 1002，不泄露 publication 是否存在 |
| publication 已撤回 | 1002 |
| 打开时部分题下架 | 标题保持 publication 手填标题；返回在架题并在响应中给实际 `questionCount` |
| 打开时全部下架 | 1002，不写已读 |
| 教研员发布已拒绝题集 | 1004 |
| 教研员重新审核非 rejected 题集 | 1004 |
| 发布非法年级编码 | 1001 |
| 同一题集重复发布同一真实年级 | 幂等或复用 publication，不产生重复收件项 |
| 题目被精选引用 | 教研删卷影响并入 retained，不物理删除 |

## 11. 测试

### 后端

1. 推荐：合法、跨学科、超 20、停用题、无答案、freeform、推荐未作答题目、重复推荐幂等、每日新题集上限 1008。
2. 聚合：相同题目不同顺序得到同一 `content_key`；不同集合不合并。
3. 推荐统计：人数去重；年级分布按推荐时快照。
4. 审核：pending/approved/rejected 状态迁移；拒绝后不可发布。
5. 发布：一个 publication 只含一个年级和独立标题；同题集可发多个年级；标准 `grade_N` 校验；reach_count 快照正确。
6. 学生列表：只返回当前年级、published、至少一道在架题。
7. 打开：越年级、撤回、全部下架均 1002；部分下架标题不变且正常返回；服务端 session 与 `featured_publication_id` 正确；已读幂等。
8. 运行：写 `special_practice_sessions` / `special_answer_records`；不写 `training_sessions`、不写 `point_ledger`；客户端漏传/伪造 `suppressErrorFixPoints` 时，服务端仍按 featured session 压制。
9. 教研：pending count、拒绝、重新审核、按年级发布、撤回。
10. 护栏：订阅豁免清单不变；删卷影响把 `featured_question_set_items` 纳入阻断表。

### 前端

11. `ProfilePage`：卡片空态、未读、分页、点击写 sessionStorage 并导航。
12. `TrainingHomePage`：有未读显示 Banner，无未读不显示，关闭只影响当前渲染，点击进入个人中心。
13. `parseRunHandoff`：`featured` 且带服务端 `sessionUid` 合法；缺 `sessionId:null` 或 `sessionUid` 非法。
14. `TargetedRunPage(featured)`：沿用交接体 sessionUid；判题与自评不依赖客户端发分布尔；完成写历史；不调积分完成；结果页无积分元素。
15. 教研审核页：pending 角标、列表、详情、发布、拒绝、重新审核、撤回及对应空态/错误态。

### 手工冒烟

一条链路：学生完成 3 题专项 → 推荐 → 教研员看到 1 人和年级分布 → 发布到该年级 → 学生个人中心看到未读题单 → 训练首页出现 Banner → 从个人中心打开 → 答错 1 题 → 结果页无积分 → 练习记录可回看 → 错题本出现该题。

## 12. 度量与去留判据

首轮观察窗口为功能首次发布后的 14 个自然日。

口径：

- 推荐学生数：窗口内 `featured_question_set_recommendations` 的去重 `student_id` 数；
- 触达数：窗口内已发布 publication 的 `reach_count` 快照之和；
- 打开数：窗口内 `featured_question_set_reads` 的去重 `(publication_id, student_id)` 数；
- 完成数：窗口内 `special_practice_sessions.featured_publication_id IS NOT NULL AND completed_at IS NOT NULL` 的去重 `(featured_publication_id, student_id)` 数。

| 指标 | 阈值 | 不达标处理 |
|---|---|---|
| 推荐学生数 | ≥10 | 需求不成立：下线推荐入口和 Banner，保留数据，停止继续投入 |
| 打开率（打开数/触达数） | ≥50% | 发现路径或题单标题不吸引：先调整个人中心卡片和 Banner；连续两周仍低于阈值则下线 |
| 打开后完成率（完成数/打开数） | ≥60% | 题目不合适：教研员缩短题数或提高选题质量；无改善则停止学生推荐，只保留人工精选能力或整体下线 |

低使用率时不保留半成品：隐藏入口和列表，保留数据表用于复盘。不得因为打开率低而重新引入学生好友或学生直发。

## 13. 文档同步

| 文档 | 动作 |
|---|---|
| `docs/K12智学系统-产品需求文档.md` | 新增「学生精选题单推荐」章节，明确无社交、按年级发布、记历史不发分 |
| `docs/API接口与数据流设计文档.md` | 新增 Student Featured Sets / Research Featured Sets 端点与数据流；补 1008 限流实现注；`open/publish/reject/reopen/withdraw` 记 200 |
| `docs/api/openapi.yaml` | 同步 11 个 operation 和响应 schema |
| `docs/K12智学系统-数据库设计文档.md` | 新增 5 张表、`special_practice_sessions.featured_publication_id` 及删卷阻断关系 |
| `docs/UX-UI设计文档.md` | 新增个人中心题单卡片、训练首页 Banner、教研审核发布页规范 |
| `docs/constraints/专项子系统.md` 或新建专题约束 | 记录“记历史但不发分”、无通用学生消息、freeform 不推荐 |

## 14. 实施顺序

1. DB：5 张表、`special_practice_sessions.featured_publication_id`、schema 折回、删卷阻断表同步、schema reconcile。
2. 后端学生推荐与聚合：repo / service / controller / 单测。
3. 后端学生列表与打开：当前年级匹配、在架过滤、服务端 session、已读幂等。
4. 后端教研审核发布：列表、详情、pending count、发布、拒绝、重新审核、撤回。
5. 运行器：`mode='featured'`、历史写入、不发分、返回个人中心。
6. 前端个人中心与训练 Banner。
7. 前端教研空间审核发布页。
8. 文档同步、14 天度量查询与一条链路冒烟。

## 15. 验收标准

- 学生之间不存在任何直接分享、好友或消息入口。
- 教研员只能按单一年级发布；同题集可分别发多个年级。
- 精选题单完整列表位于个人中心；训练首页只在未读时提供 Banner。
- 学生必须登录且当前年级匹配才能打开。
- 作答进入练习历史和错题本，但不产生任何积分流水。
- 撤回、拒绝、下架、年级变化和重复推荐均有确定行为。
- 所有新增端点显式声明角色，订阅门禁与既有隐私护栏不被绕过。

## 16. 代码落点

| 模块 | 现有落点 | 需要改动 |
|---|---|---|
| 交接体 | `apps/web/src/pages/student/training/run-handoff.ts` | `mode` 加 `featured`；featured 必须带服务端 `sessionUid` |
| 运行页 | `apps/web/src/pages/student/training/TargetedRunPage.tsx` | 使用交接体 sessionUid；featured 不发积分；返回个人中心 |
| 不发分 hook | `apps/web/src/pages/student/training/session-completion.ts` | 不改；`sessionId=null` 天然跳过 |
| 判题入口 | `apps/server/src/modules/training/training.service.ts` | 按 sessionUid 查 featured session，服务端强制压制 `error_fix` |
| 自评结算 | `apps/server/src/modules/training/self-assessment-settlement.service.ts` | 校验 featured session；保持无奖励路径 |
| 专项历史 | `apps/server/src/database/repositories/special-practice-sessions.repo.ts` | 写入/读取 `featured_publication_id`；支持 open 创建会话 |
| 判题核心 | `apps/server/src/modules/practice/judge-core.service.ts` | 不改发分判断；只消费服务端传入的 `suppressErrorFixPoints` |
| 删卷阻断 | `apps/server/src/database/repositories/research-papers.repo.ts` | `BLOCKING_TABLES` 增加 `featured_question_set_items`，补测试 |
| 年级 | `apps/server/src/common/utils/grade.ts` | 复用 `grade_N` 与宽容解析，不新增年级模型 |
| 个人中心 | `apps/web/src/pages/student/ProfilePage.tsx` | 新增精选题单卡片、分页、未读、进入运行器 |
| 训练首页 | `apps/web/src/pages/student/training/TrainingHomePage.tsx` | 新增未读 Banner，不新增常驻入口 |
| 教研导航 | `apps/web/src/components/layout/ResearchNav.tsx` | 增加入口与 pending 角标 |
| 路由 | `apps/web/src/routes/routeTable.tsx` | 新增教研列表/详情路由；个人中心仍复用 `StudentStayLayout` |

## 17. 风险与裁决

| 风险 | 处置 |
|---|---|
| 同一题集多年级标题互相覆盖 | 标题移入 publication；每次发布独立标题 |
| 客户端漏传 `suppressErrorFixPoints` | open 创建带 `featured_publication_id` 的服务端 session；判题/自评服务端强制识别并压制 |
| 历史无法对应发布、完成率失真 | `special_practice_sessions.featured_publication_id` 建立归属；用 read 与 completed session 计算漏斗 |
| 学生升年级后题单消失 | **已确认的一次性投递语义**：按发布时目标年级当前匹配，升级后不再投递；历史练习记录仍保留 |
| 个人中心入口发现率低 | 用户已裁决完整列表放个人中心；训练首页保留未读 Banner，不增加常驻入口，上线两周按打开率验证 |
| 被拒题集永久不可见 | 增加「重新审核」状态迁移 |
| 教研员长期不处理队列 | ResearchNav 显示 pending 角标；进入页面与窗口聚焦刷新 |
| 推荐数据被刷 | 题目必须出现在该生已有作答事实中；同一学生同一题集幂等；每日新题集上限 10 |
| freeform 图片跨学生 | 首期直接拒绝 freeform 题进入推荐 |
| 题集引用阻止删卷 | `featured_question_set_items` 纳入删卷阻断表和 retainedCount |
| 教研员查看年级分布触碰 PRD 隐私口径 | 只给聚合人数；同步修订 PRD 并加隐私守卫，若不允许则删除分布字段 |
