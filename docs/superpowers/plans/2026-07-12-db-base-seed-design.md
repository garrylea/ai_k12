# DB 基础种子数据设计与初始化（db_loader 前置）

## 背景
之前我手动 `CREATE DATABASE` + 加载 schema + INSERT subjects 是错的。正确做法：把基础种子数据的设计写进数据库设计文档、把种子数据加进 `schema.sql`（不另建 seed.sql），然后跑 `install_mysql.sh` 用本机已装的 MySQL 完成初始化。

## 步骤

### 1. 设计文档：`docs/K12智学系统-数据库设计文档.md`
- 在 §3 表定义之后新增一节 **「基础种子数据 (Seed)」**，说明：
  - **范围**：初始化时 seed 的「引用数据」只有 `subjects`（K12 学科：数学/语文/英语/物理/化学/生物/历史/地理/道德与法治，含 code/name/grade_bands/sort_order/is_active）。
  - **方式**：直接写在 `tools/db/schema.sql` 末尾（`INSERT IGNORE`，幂等），由 `install_mysql.sh` 加载 schema 时一并执行；**不另建 seed.sql**。
  - **边界**：`textbook_versions`/`semesters`/`units`/`lessons` 是「派生数据」，由 db_loader 从抽取结果（rel_path + lesson_id 标签）派生入库，不在 init seed 范围。
  - `subjects` 的 `code` 为 canonical（math/chinese/...）；db_loader 需把 LLM 输出的别名（如 `chem`）映射到 canonical code。
- §3.2 subjects 表说明补一句「初始数据见《基础种子数据》」。
- §7.1 MVP 如需补一句「init seed 仅 subjects」。

### 2. `tools/db/schema.sql`
- 在 `subjects` 表 `CREATE TABLE` 之后插入幂等 seed：
  ```sql
  INSERT IGNORE INTO subjects (name, code, grade_bands, sort_order, is_active) VALUES
    ('数学','math','primary,junior,senior',1,1),
    ('语文','chinese','primary,junior,senior',2,1),
    ('英语','english','primary,junior,senior',3,1),
    ('物理','physics','junior,senior',4,1),
    ('化学','chemistry','junior,senior',5,1),
    ('生物','biology','junior,senior',6,1),
    ('历史','history','junior,senior',7,1),
    ('地理','geography','junior,senior',8,1),
    ('道德与法治','politics','junior,senior',9,1);
  ```
- `INSERT IGNORE` 保证重复执行（如重新 install）不报错。

### 3. 同步相关文档
- `tools/db/install_mysql.sh` 顶部注释：补一句「schema.sql 末尾含基础种子数据（subjects），加载即完成引用数据初始化」。
- `docs/data-refinery-文档对齐总结.md`：注明 DB init seed 已在 schema.sql；db_loader 只负责派生数据（textbook_versions/units/lessons）+ cards/questions 入库。

### 4. 执行初始化
- 先 `DROP DATABASE ai_k12`（撤销之前手动建的，干净重来）。
- 跑 `./tools/db/install_mysql.sh -r 11111 -t 9.5.0 -p ai_k12`：
  - `-r 11111` root 密码；`-t 9.5.0` 避免触发 brew upgrade（装的是 9.5.0 < 默认 9.7.1）；`-p ai_k12` 指定 ai_k12 业务用户密码。
  - 脚本：建库 + 建 ai_k12 用户 + GRANT + 加载 schema（含 seed）。
- 验证：`ai_k12` 用户能连；`subjects` 有 9 行；34 张表齐全。

### 5. 后续
- db_loader 的设计与 TDD 实现单独再 plan（它会用 ai_k12 用户连库，加载 cards/questions + 派生 textbook_versions/units/lessons）。

## 不在本次范围
- db_loader 实现（下一步 plan + TDD）。
- textbook_versions/units/lessons 的 seed（归 db_loader，从抽取数据派生）。
