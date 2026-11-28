# 判题稳定性与精选题单收敛设计

**日期**：2026-11-28
**状态**：已确认，待实施
**范围**：先修复通用判题与结果页，再修正精选题单的页面、运行时逻辑和数据库设计

## 1. 结论

本次分两步实施，每一步都交付可独立验证的软件：

1. **判题稳定化**：普通专项、错题练习和考试的判题不得依赖精选题单新增表或列；结果页只根据 `questions.explanation` 是否已有内容决定是否显示解析入口。
2. **精选题单收敛**：结果页移除题号，推荐入口移到结果弹窗底部；精选会话只影响“是否发 `error_fix`”这一条积分策略；publication 改成一次投放对应一条不可复用投递记录，修正重发覆盖历史指标的问题。

第一步不执行精选数据库迁移。第二步按不可变 publication 方案重构未执行的精选迁移，再完成一次端到端曳光弹验收。

## 2. 根因与边界

### 2.1 已确认的故障链

当前 `TrainingService.judgeTraining` 只要收到 `sessionUid`，就会调用
`SpecialPracticeSessionsRepository.isFeaturedSession`。该方法查询：

```sql
SELECT featured_publication_id
  FROM special_practice_sessions
 WHERE session_uid = ? AND student_id = ?
```

代码已合并，但 `2026-11-28_curated_question_sets.sql` 尚未执行，数据库既没有该列，也没有精选相关表。由此导致：

```text
普通专项提交
  → 判题前查询不存在的 featured_publication_id
  → MySQL 1054 ER_BAD_FIELD_ERROR
  → POST /api/training/judge 500
  → 前端拿不到答案对错
```

这不是判题算法或解析算法需要新字段，而是精选积分策略的查询被错误地绑定到了通用判题关键路径。

### 2.2 判题与解析的唯一数据源

- 客观题对错：`questions.answer` + `questions.options`，由 `JudgeCoreService` 程序判定。
- 主观题：继续执行已确认的自评规则，不做程序字符串全等。
- 解析可用性：`questions.explanation` 非空才显示【查看解析】，否则不显示入口。
- 精选功能不得改变以上口径，也不新增判题 source。

### 2.3 明确不做

- 不把主观题改成直接比对 `questions.answer`。
- 不引入签名 `sessionUid`、HMAC 或第二套判题端点。
- 不为精选新增 judge source。
- 不在结果页显示“正在生成中…”、刷新倒计时或自动等待解析。
- 不因功能尚未达到留存阈值就删除已有数据。

## 3. 第一步：判题稳定化

### 3.1 宽松部署与窄降级

`isFeaturedSession` 只对“精选列尚未迁移”造成的结构缺失做兼容：

- 只检查 `err.code === 'ER_BAD_FIELD_ERROR'`，并确认错误信息明确包含 `featured_publication_id`。
- 记录一次带上下文的 warning，返回 `false`，表示按普通会话处理。
- 不兼容 `ER_NO_SUCH_TABLE`。该查询访问的是核心表 `special_practice_sessions`，表缺失属于数据库结构故障，必须继续冒泡，不能伪装成普通会话。
- 其他数据库异常继续向上冒泡，不吞错。
- 当结构缺失时，精选 `open` 本身也不可能成功创建精选会话，因此降级为普通会话不会让精选会话错误发分。

完成后，普通判题不要求先执行精选迁移。

### 3.2 结果页解析入口

数据库真源是 `questions.explanation`，前端可见性来自父层批量读取后传入的
`initialExplanations`，组件内对应 `explanations[q.n]`。不是给 `PracticeQuestion`
新增 `explanation` 字段。

`AnswerResultList` 的解析入口统一采用一条可见性规则：

```text
explanations[q.n] 非空 → 显示【查看解析】
explanations[q.n] 为空 → 不显示任何解析入口
```

同时删除结果列表中的：

- “正在生成中…”提示；
- 解析【刷新】按钮；
- 120 秒倒计时；
- `onWaitExplanation` 回调；
- `questionIdOf` 以及仅用于“无解析但有 questionId”分支的“正在生成中…”提示。

外层状态门控继续保留，不能把“解析非空”误解成所有题都显示解析：

- 客观题保留 `!correct && !failed && !noAnswer && !unscored`，只替换内层“有解析 / 正在生成中 / 刷新”的分支。
- 主观题原来无条件显示【查看解析】，本次改为仅在 `subjective && !failed && explanations[q.n]` 时显示。
- 主观题展开后如传了 `referenceAnswers`，参考答案照常显示。

解析生成仍由答错后的后台缓存任务负责。结果页不等待、不主动触发生成。

### 3.3 结果页时序

保持当前“先进入结果页、后台补取已有解析”的时序：

1. 末题所有判题 Promise settle。
2. 立即调用 `setPhase('result')`。
3. 后台批量读取 `questions.explanation`。
4. 返回非空解析后合并到结果页。

解析请求失败或永不返回，不得阻塞结果页。

### 3.4 测试

- Repository：`isFeaturedSession` 在 MySQL `ER_BAD_FIELD_ERROR` 且消息包含 `featured_publication_id` 时返回 `false`；`ER_NO_SUCH_TABLE` 和其他异常继续抛出。
- Training service：缺少精选 schema 时，带 `sessionUid` 的普通客观题仍返回判题结果。
- `AnswerResultList`：无解析时主客观题均无【查看解析】；有解析时显示。
- `AnswerResultList`：不再渲染“正在生成中…”和【刷新】。
- `TargetedRunPage`：解析请求挂起时结果页仍立即可见。
- `ErrorPracticeRunPage`、`CleanupPhase`、`CourseDetailPage`、`ExamResultPage`：移除刷新依赖后原有结果渲染不回归。

## 4. 第二步：精选题单页面

### 4.1 结果页题号

从 `AnswerResultList` 删除状态图标左侧的题号展示及其测试。

程序内部继续使用 `q.n` 和 `questionId` 作为键，不改变判题、解析、错题或打印逻辑。

### 4.2 推荐入口位置

`AnswerResultList` 新增可选 `footerExtra` 插槽。底部操作行结构为：

```text
[推荐这套题]                          [导出 PDF] [确认]
```

- 推荐入口属于结束类动作，不再使用 `headerExtra`。
- `TargetedRunPage` 将 `RecommendFeaturedSetButton` 传入 `footerExtra`。
- 积分重试和补偿套题询问仍位于标题下方，不与推荐入口混放。
- 宽度不足时底部操作行允许换行，但保持同一个底栏区域。
- 考试结果页不传 `footerExtra`，布局保持不变。

### 4.3 页面测试

- 结果列表不出现题号。
- 只有 `TargetedRunPage` 结果页出现推荐按钮。
- 推荐按钮与【导出 PDF】【确认】处于同一底部操作区。
- 标题下方不再出现推荐按钮槽位。
- 积分重试、补偿套题原有可见性不变。
- 所有 `AnswerResultList` 调用方均不显示题号。

## 5. 第二步：运行时逻辑

精选题单不进入判题核心，只向通用判题提供一项服务端可信的积分策略。

### 5.1 会话创建

`FeaturedDeliveryService.open` 在单事务内：

1. 锁定当前有效的 publication。
2. 创建普通 `special_practice_sessions`。
3. 写入该 session 对应的不可变 publication ID。
4. 幂等写入 publication 已读记录。

任一步失败则整体回滚，不返回没有服务端凭据的题单。

### 5.2 判题

通用 `judgeTraining` 保留一个判题入口：

1. 读取题目并对答案。
2. 服务端按 `sessionUid + studentId` 解析会话积分策略。
3. 普通会话按既有规则发 `error_fix`。
4. 精选会话答对仍清错题，但强制跳过 `error_fix`。
5. 客户端布尔值不作为精选会话的信任依据。

不新增 HMAC、不新增 judge source、不复制 `JudgeCoreService`。

`suppressErrorFixPoints` 继续保留，不能删除：

- 单题重做（redo）仍通过客户端显式传 `true`，这是正式业务语义；
- 精选保证不来自该布尔值，而来自服务端 session 归属；
- 现有“客户端 `true` 或服务端精选 = `true`”的 OR 规则保留，客户端只能请求压分，不能用 `false` 翻转精选压分。

### 5.3 主观题

主观题继续进入现有 self-assessment settlement。带 `sessionUid` 的训练轨主观题本来
就不会写 `error_fix`，因为 settlement 不发该积分，与是否精选题单无关。精选会话沿用同一状态机：

- 默认错、确认对、确认错的历史和错题副作用照常执行；
- 精选策略对主观题不新增第二套积分分支；
- 不写 `training_sessions` 或 `point_ledger` 是精选整轮的既有约束。

## 6. 第二步：数据库设计

### 6.1 保留五张业务表

以下五张表分别承载不同生命周期，保留独立表：

1. `featured_question_sets`：题集身份和审核状态。
2. `featured_question_set_items`：题集组成与顺序。
3. `featured_question_set_recommendations`：学生推荐票与推荐时年级快照。
4. `featured_question_set_publications`：一次发布投放。
5. `featured_question_set_reads`：学生对一次 publication 的已读事实。

### 6.2 publication 是不可复用的投递记录

`featured_question_set_publications` 的语义改为“一次投放使用一个不可复用的 ID”：

- 一行代表一次特定年级、标题、触达快照和发布时间；
- 撤回只写 `withdrawn_at/withdrawn_by`；
- 撤回后重新发布必须新增一行；
- `published_at`、`reach_count` 和发布时间永不因重发而覆盖；
- 旧 reads、练习 session 和指标继续关联旧行。

若同一题集和年级已经有一条有效 publication，再次发布只修改该行标题；不改变发布时间、触达快照或 publication ID。因此“重发新增”特指撤回后的再次发布。

删除 `status`，当前是否有效由 `withdrawn_at IS NULL` 判断。仓储对外继续映射
`published|withdrawn`，避免 API 契约变化。

仓储中所有原先读取、筛选或写入 `status` 的查询都必须同步改为时间字段语义：

- 学生列表、未读数、open：只认 `withdrawn_at IS NULL`；
- 教研详情：有 `withdrawn_at` 映射 `withdrawn`，否则映射 `published`；
- withdraw：只更新 `withdrawn_at IS NULL` 的行；
- publish：按本设计第 6.3 节的分支处理。

### 6.3 发布分支

`FeaturedReviewService.publish` 的前置错误码不变：

- 题集不存在：1002；
- 题集已拒绝：1004；
- 标题或年级非法：1001。

仓储事务先 `SELECT ... FOR UPDATE` 锁题集行，再按以下分支写入：

| 当前状态 | 仓储动作 | 返回 |
|---|---|---|
| 同 set/grade 已有有效 publication | 只更新该行 `title`；不改 `published_at/reach_count/published_by/withdrawn_at` | 原 publicationId |
| 同 set/grade 只有已撤回历史行 | 插入新 publication，新标题、新 `reach_count`、新发布人和发布时间 | 新 publicationId |
| 同 set/grade 没有任何历史行 | 插入新 publication | 新 publicationId |
| 同 set 的其它年级 | 新建该年级 publication | 新 publicationId |

题集行锁负责串行化同一题集的发布；`uniq_fqsp_active` 是并发兜底。任何分支都不删除
`featured_question_set_reads`，也不查询后再按旧的 `(set_id, grade_code)` upsert。

### 6.4 活跃 publication 唯一性

同一题集同一时间只能有一个目标年级的有效投递。使用存储生成列和唯一键保证：

```sql
active_publication_key VARCHAR(64)
  GENERATED ALWAYS AS (
    CASE
      WHEN withdrawn_at IS NULL THEN CONCAT(set_id, ':', grade_code)
      ELSE NULL
    END
  ) STORED,
UNIQUE KEY uniq_fqsp_active (active_publication_key),
KEY idx_fqsp_grade_active (grade_code, withdrawn_at, published_at)
```

历史撤回行生成值为 `NULL`，MySQL 唯一键允许多行 `NULL`，因此历史 publication 可以保留。

迁移必须显式删除旧约束和索引：

- 删除 `UNIQUE KEY uniq_fqsp_set_grade (set_id, grade_code)`，否则撤回后新增同 set/grade 会撞唯一键；
- 删除依赖 `status` 的 `KEY idx_fqsp_grade_status (grade_code, status, published_at)`；
- 新建 `UNIQUE KEY uniq_fqsp_active (active_publication_key)`；
- 新建 `KEY idx_fqsp_grade_active (grade_code, withdrawn_at, published_at)`。

当前目标库没有该表，因此直接修正未执行的建表迁移，不写历史数据回填。若某个非目标环境已经执行旧迁移，迁移需先用 `information_schema` 判断旧索引是否存在，并幂等执行 `DROP INDEX`，再创建新索引。

### 6.5 reads 与历史

- `featured_question_set_reads` 继续以 `(publication_id, student_id)` 为主键。
- 撤回不删除 reads。
- 重发创建新 publication，因此天然产生新的未读投递。
- 打开率、触达数和完成率均按真实 publication ID 统计，不再把两次投放混在一起。
- 同一学生重复打开同一 publication 会创建新的专项 session，这是允许的多次作答事实；完成数按 `(publication_id, student_id)` 去重，只要求至少一条 session 已完成，不按 session 数累加。

### 6.6 练习 session 关联

`special_practice_sessions.featured_publication_id` 保留为可选关联。现状是
`ON DELETE SET NULL`，本次改为 `ON DELETE RESTRICT`：

- publication 是历史归属凭据，不允许级联删除后静默丢失；
- 题集和 publication 的运营操作只允许撤回，不物理删除；
- 普通 session 的该列恒为 `NULL`。

`featured_question_sets -> featured_question_set_publications` 仍为 `ON DELETE CASCADE`。
因此物理删除已被 session 引用的题集时，级联删除 publication 会被 session 的 RESTRICT
外键阻断；该失败模式是预期的数据保护，运营操作必须使用撤回，不物理删除。

### 6.7 迁移策略

当前目标库没有精选表和 `featured_publication_id`，因此：

- 直接修正尚未执行的 `tools/db/migrations/2026-11-28_curated_question_sets.sql`；
- 同步修正 `tools/db/schema.sql`；
- 同步修正数据库设计文档、现有精选题设计稿和 API 数据流中的 publication 语义；
- 不存在线上精选数据回填。

执行顺序必须是：

```text
修改 migration 与 schema.sql
  → 手工执行 migration
  → 再跑 python3 tools/db/schema_reconcile.py
  → 最后部署依赖新结构的代码
```

当前 `schema.sql` 已包含旧版五表，目标库仍是 0 张精选表；若先改 schema.sql 并直接对账，
会按预期出现 schema-only 漂移。第一步的窄降级保证迁移顺序错误时不会再次拖垮普通判题。

## 7. 数据流

### 7.1 推荐与发布

```text
学生推荐题目集合
  → content_key 幂等创建题集
  → 写题目顺序和学生推荐票
  → 教研员审核
  → 发布到 grade_N
  → 插入一条新的不可变 publication
```

同一题集发布到不同年级 = 多条 publication。

同一题集同一时间重复发布到同一有效年级 = 更新该有效 publication 的标题，不新增投递；撤回后再次发布 = 新增 publication。

### 7.2 打开与作答

```text
学生打开 publication
  → 校验年级和 withdrawn_at
  → 创建 special_practice_session
  → 关联 publication ID
  → 幂等标已读
  → 返回题单
  → 通用判题入口作答
```

### 7.3 完成与度量

完成后照常写专项 session 完成时间。指标按不可变 publication ID 聚合：

- 触达数：窗口内 publication 的 `reach_count` 之和；
- 打开数：窗口内 reads 的 `(publication_id, student_id)` 去重数；
- 完成数：窗口内带 publication ID 且至少一条 session 已完成的 `(publication_id, student_id)` 去重数；
- 同一 publication 重复打开产生的多条 session 不增加完成数。

本设计不新增 admin 指标端点。指标继续由
`tools/db/featured_question_set_metrics.sql` 提供，供运营或后续报表功能手工执行；
若未来要进入管理端，另立端点设计和权限评审。

## 8. 曳光弹验收

第二步实施后，用一条完整链路验证所有层次：

1. 学生完成一项 3 题专项练习。
2. 从结果页底部点击【推荐这套题】。
3. 教研员看到推荐人数和年级分布。
4. 教研员填写标题并发布到匹配年级。
5. 学生个人中心看到一条未读精选题单。
6. 训练首页出现未读 Banner。
7. 学生打开题单，服务端创建带 publication ID 的 session。
8. 答错一题：结果页不显示题号，错题照常入错题本。
9. 答对一道原本未清零的错题：错题被清零，但不写 `error_fix` 流水。
10. 结果页无积分元素，推荐按钮位于底部操作栏。
11. 练习记录可回看，家长端无新增精选入口。
12. 同一题单重复打开两次：生成两条 `special_practice_sessions`，但完成数仍按学生和 publication 只计一次。
13. 撤回后重新发布：新 publication 形成新的未读；旧完成记录仍关联旧 publication。

## 9. 失败处理

| 场景 | 处理 |
|---|---|
| 精选列尚未迁移 | 普通判题降级为普通策略并继续返回对错；精选 open 返回既有不可用错误 |
| `special_practice_sessions` 核心表缺失 | 不降级，继续抛 `ER_NO_SUCH_TABLE` |
| 精选迁移已存在 | 正常解析精选策略 |
| 解析不存在 | 不显示解析按钮，不触发生成 |
| 批量解析请求失败或挂起 | 结果页立即显示，只缺少解析按钮 |
| publication 已撤回或年级不匹配 | 统一 1002，不泄露存在性 |
| 重发时已有有效 publication | 只更新该投递标题，不创建第二个有效投递 |
| 重发时原 publication 已撤回 | 新增 publication，历史 reads/session 不变 |
| 物理删除已被 session 引用的题集 | CASCADE 到 publication 时被 session RESTRICT 阻断；操作失败，应改用撤回 |
| 普通数据库异常 | 继续冒泡，不按“普通会话”吞掉 |

## 10. 验证清单

### 10.1 第一步

- server 相关单测通过；
- web 相关渲染测试通过；
- `npm run build` 通过；
- 在未执行精选迁移的数据库上手工提交一道普通客观题，判题返回正确结果。

### 10.2 第二步

- 精选迁移可重复执行；
- 严格执行“改 migration/schema → 手工执行 migration → schema reconcile → 部署代码”的顺序；
- `schema_reconcile.py` 对账通过；
- API 文档与 `openapi.yaml` 同步；
- server/web 全量测试、build、lint 通过；
- 完成第 8 节曳光弹全链路。

## 11. 文档同步

实施时同步以下文档：

- `docs/K12智学系统-产品需求文档.md`：仅补实现注，不改变已确认产品口径。
- `docs/API接口与数据流设计文档.md`：publication 不可变投递语义、重发数据流、解析只读口径。
- `docs/api/openapi.yaml`：仅同步机器可读契约变化。
- `docs/K12智学系统-数据库设计文档.md`：五张表字段和唯一键修正。
- `docs/superpowers/specs/2026-11-28-curated-question-set-design.md`：标注被本设计取代的 publication 重发语义。
- `docs/constraints/专项子系统.md`：补普通判题不得依赖精选 schema、解析只读、不可变 publication 三项硬约束。
- `docs/ai-core-changelog.md`：记录事故根因、两步实施和曳光弹结果。
