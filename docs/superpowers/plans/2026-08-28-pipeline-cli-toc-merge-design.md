# 数据管线统一编排（pipeline_cli）+ TOC 合并 + 配置引导

> **状态：已实施**（2026-08-28，515 个测试通过）。产物：`tools/data-refinery/src/`
> 下的 `pipeline_cli.py` / `toc_merge.py` / `env_bootstrap.py`，及 extract/db_loader
> 的 `--toc-dir` 扩展。使用方式见 [使用手册 §4.7](../data-refinery-使用手册.md)。

## 目标

把 convert 之后的管线（toc_parse → extract → publish → db_loader）统一为一个入口脚本，解决三个问题：

1. **执行顺序混乱**：各阶段手工按序跑，无全局编排
2. **补充目录丢失**：card 分析发现的小节（如 26.1.1）从不合并回 toc.json；db_loader 存在两条互斥路径（动态 find-or-create vs TOC 模式折叠+WARN 跳过）
3. **配置割裂**：deploy.sh 生成 `apps/server/.env`，而 `tools/data-refinery/.env` 需手写

**用户已确认的决策：**
- 新建总控脚本 `pipeline_cli.py`（复用现有阶段函数，argv 透传模式照抄 refinery_cli.py:16-17）
- 教材/试卷自动分流；各阶段沿用现有 checkpoint 断点续跑，重复执行只处理新增/未完成部分
- 默认增量入库；`--purge-business-data` 显式传参才全量重载
- TOC 入库前文件层合并：card 发现的新小节合并进目录（sidecar 文件），然后一次 load_toc_structure + load_cards
- 目录注入 card_labeler prompt（实现设计文档 §4.4 遗留项）
- 配置引导在 pipeline_cli 启动时做（不在 deploy.sh）：读 deploy 已生成的文件 → 用户选 provider → 生成 tools/data-refinery/.env；无源文件时报错要求先跑 deploy.sh

## 已验证的关键事实

- `refinery_cli.py:16-17,47-54`：`from X import main as X_main` + argv list 调子 CLI —— pipeline_cli 照抄，不重构
- `config.py:18`：`load_dotenv(tool_dir/".env", override=False)` 在 import 时执行 → bootstrap 写完 .env 后必须重新 `load_dotenv(override=True)`
- toc.json schema（`prompts/toc_parse.txt:19-56`）：`{book, chapters:[{number,title,label,sections:[{number:[N,M],title,label,printed_page,subsections:[…]}],supplements:[…]}]}`
- `db_loader.py:180-201` `parse_lesson_id`：纯函数，`第N章 X`→chapter；`N.M[.K] X`→section tuple
- `db_loader.py:552-647` `load_toc_structure`：subsections 已建 lesson 行（619-625）；文件路由规则（试卷/答案→questions，否则 cards）
- `db_loader.py:456-461` `_match_lesson_by_name` 全局按名查 → 跨书同名碰撞 bug；`688-694` 子节坍缩+WARN 跳过
- `card_labeler.py:142-166` label() 只收 cards_text/page_number/prev_lesson_id，LLM 看不到 TOC
- `extract_cli.py:175-232` `validate_and_correct` 事后模糊校正（Levenshtein≤2，改写 jsonl）
- deploy.sh `write_env`（458-489）：apps/server/.env 只写 `{P}_BASE_URL/{P}_API_KEY`（kimi/qwen/gemini/deepseek）+ `DB_*`，**无模型名**；模型名在 model-routes.yaml（apply_llm_yaml 491-501 改写）和 `tools/deploy/runtime/deploy.state.json`（`LLM_${P}_MODEL/BASE_URL/API_KEY` 齐全）
- `llm.py:132-213`：各 provider 子类自带含 `/v1` 路径的 default_base_url；REGISTRY 名与 deploy.sh 一致

## 实施步骤（小提交顺序）

### 1. feat: env_bootstrap — `tools/data-refinery/src/env_bootstrap.py`（新文件）

```python
PROVIDERS = ("kimi", "qwen", "gemini", "deepseek")
def _parse_env_file(path) -> dict          # KEY=VALUE 行级解析
def _parse_model_yaml(path) -> dict        # provider -> modelId（复刻 apply-llm-config.mjs 的 yaml 结构解析）
def _collect_providers(server_env, yaml_path, state_path) -> dict
    # base_url/api_key 优先 apps/server/.env，缺项从 deploy.state.json 的 LLM_${P}_* 补；
    # model 名优先 model-routes.yaml 主 key，兜底该 provider 第一个 model 块；三项齐才进菜单
def ensure_refinery_env() -> None
```

`ensure_refinery_env()` 逻辑：
1. `tools/data-refinery/.env` 已含 `LLM_PROVIDER+LLM_MODEL+LLM_AUTH_TOKEN` → return（幂等，零开销）
2. 无 `apps/server/.env` → 报错退出：先运行 `tools/deploy.sh`，或参照 `.env.example` 手动配置
3. 交互菜单列出已配置 provider（模型名+base_url），用户编号选择（支持 `REFINERY_PROVIDER=kimi` 环境变量免交互）
4. 生成 `tools/data-refinery/.env`：`LLM_PROVIDER/LLM_MODEL/LLM_AUTH_TOKEN=API_KEY/LLM_BASE_URL` + `DB_*`（从 server .env 拷）+ `MINERU_*/LLM_TIMEOUT=120/LLM_MAX_RETRIES=3/LLM_MAX_TOKENS=16384/LLM_THINKING=false/LLM_ENABLE_CACHE=false`（.env.example 默认值）
5. **`load_dotenv(tool_dir/".env", override=True)`** —— 让本进程 config 立即生效
6. base_url 规范化：收集到的 URL 无路径（只有 scheme+host）→ 写空值让 per-provider default 生效；有路径（自建代理）→ 原样写

测试：`tests/test_env_bootstrap.py`（tmp 目录伪造 server .env/yaml/state；完整/部分/缺失、base_url 规范化、override 加载）

### 2. feat: labeler TOC 注入 — `card_labeler.py` + `prompts/textbook_cards.txt` + `extract_cli.py`

- `label()` 加参数 `toc_labels: list[str] | None = None`；user_message 追加 Legal lesson_id list（要求逐字复制，>300 条截断）
- `prompts/textbook_cards.txt:66-70` §lesson_id 重写：列表中有 → 必须逐字复制；仅当页面确实出现列表中没有的编号节标题 → 输出页面原文；节内标题/续页卡 → null
- `extract_cli.py` 加 `--toc-dir`：构建 book_key→toc dict 缓存（扫 `{toc_dir}/**/*.json`，排除 `*.merged.json`/`*.merge_report.json`）；cards 类且缓存命中的书注入 `toc_labels`；页循环后逐书跑 `validate_and_correct`（就地改写 jsonl，**不写 diff_report.json**——merge_report 取代）

### 3. feat: toc_merge — `tools/data-refinery/src/toc_merge.py`（新文件，纯函数可单测）

```python
collect_card_labels(published_dir, book_key) -> dict   # 按页序扫 published/*.jsonl，{label: {first_textbook_page, count, parsed}}
merge_toc(toc, card_labels) -> (merged_toc, report)    # report: matched/new_sections/new_subsections/new_chapters/unresolved/summary
run_merge(output_dir, source, dry_run=False) -> list[Path]
    # 每书：读 toc.json → merge → 写 output/toc/{book_key}.merged.json + .merge_report.json
```

合并算法：
1. exact 集合 = `_flatten_toc_labels(toc)`（从 extract_cli import）；命中 → matched
2. 未命中标签用 `parse_lesson_id`（从 db_loader import）解析：
   - `第N章 X` → chapter N 无则新建（`source:"card"` 标记），有则补齐 title/label
   - `N.M` → chapter.sections 找 `[N,M]` 无则按 M 排序插入
   - `N.M.K` → section `[N,M]` 的 subsections 找 `[N,M,K]` 无则按 K 插入；**父节也缺** → 连 section 一起补（report 标注 `section_created_from_subsection: true` 提示人工复核）
   - 解析失败 → unresolved，不合并
3. 排序不变式：chapters 按 number、sections 按 number[1]、subsections 按 number[2]；`printed_page` 补自首见卡的 textbook_page
- **写 sidecar `.merged.json`，不回写 toc.json**（保护 toc_parse 的 LLM 原始产物和 `--reconvert` 语义）
- **merge 无需 checkpoint**：确定性纯函数，每次全量重算（毫秒级）

测试：`tests/test_toc_merge.py`（新子节/新节/缺父节/新章/unresolved/排序/幂等重跑）

### 4. fix: db_loader 作用域匹配 + `--toc-dir` — `db_loader.py` + `db_loader_cli.py`

- `_match_lesson_by_name(name, semester_id=None)`：给定时 `JOIN units WHERE u.semester_id=%s AND l.name=%s`；有章号先按 `(semester_id, sort_order=N)` 查 unit 在 unit 内匹配，miss 退到 semester 范围。`_match_parent_lesson` 同样加作用域
- 抽 find-only `_lookup_semester(info)`（复用现有查询逻辑不创建），`load_book_cards` toc 模式开头定位 semester 后传给匹配函数
- `db_loader_cli.py` 加 `--toc-dir`：
  - `--load-toc --toc-dir`：遍历 `*.merged.json`（fallback `.json`）逐个 load_toc_structure
  - `--load-cards --toc-dir`（pipeline 默认增量）：每 card 书先 `load_toc_structure(merged)`（幂等 find-or-create，补出的节建成 lesson 行）再 `load_book_cards(toc_path=merged)`
  - 全量+`--toc-dir`：reset 后同上
- 单文件 `--toc-path` 旧模式保持原样（向后兼容）；**坍缩路径（688-694）保留不删**——merged TOC 下 exact 几乎全命中，坍缩只兜底漏网标签；加注释说明 pipeline 应传 merged TOC

测试：`tests/test_db_loader.py` 增例

### 5. feat: pipeline_cli — `tools/data-refinery/src/pipeline_cli.py`（新文件）

```python
from env_bootstrap import ensure_refinery_env
from toc_parse_cli import main as toc_parse_main
from extract_cli import main as extract_main
from publish_cli import main as publish_main
from db_loader_cli import main as db_loader_main
from toc_merge import run_merge
```

参数：`--source {all|zgkao|smartedu}`（默认 all）、`--dry-run`、`--purge-business-data`、`--skip-toc/--skip-extract/--skip-publish/--skip-load`、extract 节流透传（`--interval` 等）

main() 顺序：
1. `ensure_refinery_env()`（第一行，先于任何 RefineryConfig 使用）
2. `toc_parse_main([...])`（!skip_toc；source 含 smartedu 教材）
3. `extract_main([... --toc-dir out/toc ...])`（!skip_extract）
4. `publish_main([...])`（!skip_publish）
5. `run_merge(out, source, dry_run)`（merge 全量重算）
6. `db_loader_main(["--load-cards", "--source", src, "--toc-dir", out/toc, ...])`（!skip_load；`--purge-business-data` 时去掉 `--load-cards` 加该参数走全量）

source==zgkao 时 toc/merge 自然空转。测试：`tests/test_pipeline_cli.py`（mock 各 X_main 断言 argv 透传与顺序，照 test_refinery_cli 风格）

### 6. docs: 文档更新

- `docs/data-refinery-使用手册.md`：§2 配置引导说明、§4.7 pipeline_cli、§5 工作流改写为 pipeline_cli 优先、§6 目录树加 `*.merged.json`/`*.merge_report.json`、§7 checkpoint 表加 merge 行（无 checkpoint，确定性重算）、§8 FAQ
- `docs/data-refinery-TOC目录优先管线设计.md`：§4.4 标注已实现 + 补 merged-TOC 设计节
- `tools/data-refinery/README.md`：快速开始替换为 pipeline_cli 一条龙
- `tools/deploy.sh` 至多改注释/收尾提示（print_summary 提一句 pipeline_cli），不改变行为

## 边界（what NOT to do）

- 不重构各 stage CLI 内部循环；不改 crawler / convert_cli（pipeline 从 toc_parse 开始）
- 不删 dynamic find-or-create 路径和坍缩路径（旧 CLI 模式 A/B/C 全保持现状）
- 不回写 toc.json；merge 产物只落 sidecar
- deploy.sh 不做配置生成（选择动作在 pipeline_cli 里）
- 不动 apps/server 代码

## 风险点

1. `load_dotenv(override=True)` 时机——bootstrap 必须在任何 `RefineryConfig.from_env()` 之前（pipeline main 第一行）
2. model-routes.yaml qwen 有 3 个 model 块——解析按"主 key 优先、provider 首块兜底"
3. gemini 在 refinery 侧走 OpenAI 兼容端点（llm.py:191-195），base_url 规范化须覆盖
4. extract `--toc-dir` 后置校验会就地改写 extracted jsonl——若已 publish 过需清对应 publish checkpoint（`validate_and_correct` 改写发生后加一行防御：unmark published）

每步完成后跑 `cd tools/data-refinery && pytest`（network 标记默认跳过）。
