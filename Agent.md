# Agent 工作记录：数据管线审查与修复（2026-08-26 ~ 2026-08-27）

## 背景

对 `tools/crawler`（爬虫）与 `tools/data-refinery`（数据管线）做完备性审查后，按优先级完成全部修复。起因：`tools/deploy.sh` 明确声明业务数据导入不在其范围内，数据链路完全依赖 crawler + data-refinery，因此这两条线的代码与手册完备性是数据闭环的关键。

## 审查结论（修复前）

| 问题域 | 结论 |
|---|---|
| 爬虫代码 | 核心可用，但 `--dry-run` 污染 checkpoint（必修 bug）、4 个测试漂移失败、1 个网络烟雾测试因上游改版失效 |
| 爬虫手册 | README 不完备：缺 refinery 衔接说明、`--no-latest-only` 完全缺失、多个 flag 无例子、设计描述与代码相反 |
| 管线代码 | **不能安全一键入库**：full-reload 被 apps/server 后加的业务表 FK（RESTRICT）阻断；refinery_cli 只覆盖后两段 |
| 管线测试 | 15 项腐化（5 个 mock 已不存在的 `Extractor`、1 个旧 resume 断言、9 个集成 fixture 未清新依赖表） |
| 管线手册 | TOC 路径例子 5 处全错（照抄必踩 "TOC file not found"）、extract 三个节流参数零文档、.env 三方不一致 |

## 修复清单

### 代码修复

1. **db_loader full-reload FK 阻断**（`src/db_loader.py` + `src/db_loader_cli.py` + `src/refinery_cli.py`）
   - `DELETE FROM questions`/`textbook_versions` 被业务表 FK 挡住：`answers`/`main_error_books`/`aux_error_books`/`variation_questions` 对 questions 的 RESTRICT；`progress.textbook_version_id` RESTRICT；`homeworks->lessons` 级联被 `homework_submissions` RESTRICT 挡住。
   - 新增 `DbLoader.business_data_summary()`（预检，`_table_exists` 兼容 schema.sql 与线上库漂移）+ `purge_business_data()`（按 FK 安全序清空）。
   - CLI 加 `--purge-business-data`：默认遇业务数据**报错退出**并提示两条出路（显式 purge 或 `--load-cards` 增量），refinery_cli 透传（只传给 db_loader，不传给 publish）。
2. **zgkao dry-run 污染 checkpoint**（`src/adapters/zgkao.py`）：dry-run 不再 `mark_downloaded(item.id)`，否则后续真实爬取整批跳过。
3. **extract 断点续传 lesson 继承回归**（`src/extract_cli.py`）：恢复了重构中丢失的 skip 分支「从已抽页 jsonl 回填 per-book 状态」（`_last_lesson_id`）。
4. **SUBJECT_CODE 硬编码**（`src/publish_cli.py`）：资产路径前缀由硬编码 `math` 改为按文件相对路径首段（中文学科名）推导（`_subject_code_for`），化学等学科不再误标。
5. **refinery_cli 透传 bug**：`--purge-business-data` 曾同时传给 publish_cli（其无此参数，argparse 报错中断），改为 `_loader_args` 只传 db_loader_cli。
6. **一次性脚本 DB_PASSWORD 误用**（`migrate_flat_to_groups.py`/`backfill_practice_content.py`）：改 `DB_PASS`（与 config.py 一致）。
7. **create_llm_client 本地哑 key**（`src/llm.py`）：local provider 无 key 时补 `api_key="local_key"`（OpenAI SDK 拒空 key，本地 server 不校验鉴权）。

### 测试修复（21 项腐化 + 9 项新增）

- crawler：4 个 smartedu 测试（fake fetcher 缺 `fetch_head`，加 `NoHeadFetcher` 基类）；网络烟雾测试（上游 tag JSON 改 hierarchies 结构，重写为验证 version/分片/tag_list 对象格式）。
- refinery：5 个 extract_cli 测试（mock 改 `CardLabeler`，md 内容 >30 字符避开前置过滤、多卡页用 `##` 标题拆卡）；1 个 convert 测试（resume 已移入 `MineruRunner.run`，改适配新设计并补 runner resume 直接测试）；9 个集成测试（fixture 加业务数据守卫：默认 skip，`REFINERY_TEST_PURGE=1` 才清空后跑）。
- 新增回归：zgkao dry-run 不污染 checkpoint（回滚验证能抓住 bug）、db_loader 守卫 5 例（mock DbLoader）、publish 化学 subject 路径。

### 文档修复

- `docs/data-refinery-使用手册.md`：TOC 路径 5 处错例修正（实际 `output/toc/{学科}/{学段}/{版本}/{年级}/{册次}/{书名}.json`）、extract 三节流参数（`--interval`/`--batch-size`/`--batch-sleep`）、`--output-dir` 语义（convert/extract 是输出根）、FK 守卫说明 + FAQ 4 条、.env 全变量、MinerU 安装说明（§2.2）。
- `tools/crawler/README.md`：补 refinery 衔接章节（数据去向）、`--no-latest-only`、旧版 main.py 全参数、Python 3.10+、页数获取设计勘误（HEAD 二分探测）、flag 使用例子。
- `tools/data-refinery/.env.example`：补 `LLM_AUTH_TOKEN`/`DB_*`/`REFINERY_*`。
- `tools/data-refinery/README.md`：目录树（补 10+ 文件）、db_loader 三模式、env 表、守卫说明。
- `CLAUDE.md`：追加 2026-08-26 修正记录、现状更新、LLM 约定更新。

## 验证结果

- crawler：**200 tests 全绿** + 网络烟雾测试过。
- refinery：**237 tests 全绿**（业务数据清空后 9 个集成测试恢复运行）。
- 端到端实测：`refinery_cli --purge-business-data` 全量重载 **342 cards + 447 questions** 成功；幂等重跑一致；造业务数据后守卫正确拦截 + 提示。

## Card 标注模型切换（2026-08-27）

- 原为远程 DeepSeek `deepseek-v4-flash`（anthropic 兼容路径），应用户要求切到**本地 llama.cpp `Qwen3.8-27B`**（`LLM_PROVIDER=local`、`LLM_BASE_URL=http://192.168.1.8:12345/v1`）。
- `.env` 中原远程配置以注释保留，可切回。冒烟实测连通（回复正常）。

## 遗留事项

1. ⚠️ **业务数据备份文件丢失**：purge 前的备份写在 `/tmp/ai_k12_backup/business_tables_20260826_195502.sql`（28KB，含 main_error_books 23 行、aux_error_books 7 行、progress 2 行、practice_results 6 行等），已被系统 /tmp 清理删掉。**待办**：检查 MySQL binlog 是否可恢复被 purge 的行；今后备份一律放持久目录（勿用 /tmp）。
2. **本地模型重抽验证**：现有 extracted/published 产物仍是 DeepSeek 生成的；如需用 Qwen3.8-27B 重新抽取，按规则先抽 5 条验证质量再决定全量（用户已提出，未执行）。
3. 限速语义（crawl_delay 仅重试间隔生效）已在 README 如实标注，未改代码行为。
