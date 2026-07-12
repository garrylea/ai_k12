# data-refinery 文档对齐工作总结

> 本文档记录 `tools/data-refinery/` 模块在 convert/extract pipeline 开发过程中，设计文档与实际代码对齐工作的完成情况与遗留事项。

---

## 一、背景

`tools/data-refinery/` 实现 two-stage 离线 pipeline：

1. **convert**：递归扫描爬虫下载的 PDF/教材图片，调用 `mineru-open-api` 转换为 Markdown
2. **extract**：递归扫描 Markdown，调用 LLM 提取试卷题目或教材卡片，输出结构化 JSON

设计文档 `docs/文档转换设计.md` 最初是实施计划，实际编码过程中在多处偏离了原计划。本工作的目标是**让设计文档与实际代码完全一致**（用户明确指示："让文档与代码保持一致吧"）。

---

## 二、已完成任务

### 阶段一：教材输出结构对齐

实际代码将同一目录下所有 `page_*.jpg` 作为一个 Material 批量传给 mineru，生成扁平的 `page_NNN.md` 文件 + 共享 `images/`，而原设计文档描述的是每页独立子目录。

| # | 更新位置 | 变更内容 |
|---|---------|---------|
| 1 | 转换策略（line 21-24） | 教材从"每张 `page_*.jpg` 独立输出目录"改为"同一目录所有 `page_*.jpg` 批量一次调用" |
| 2 | 目录结构图（line 52-57） | 从"书名.md + images/"改为"`page_001.md`、`page_002.md`、... + 共享 `images/`" |
| 3 | Task 3 扫描器 | `Material.kind` 从 `"image"` 改为 `"images"`；测试改为"批量一个 Material"；实现代码对齐 `scanner.py` |
| 4 | Task 5 转换器测试 | 测试从单图改为批量调用，验证 mineru 一次接收所有 `page_*.jpg` |
| 5 | Task 6 CLI 过滤 | `material.kind == "image"` 改为 `material.kind == "images"` |
| 6 | Task 11 MarkdownScanner 测试 | 改为验证扁平结构（多个 md 共享同一 `rel_path`） |
| 7 | 自检清单 3.1 / 3.3 | 教材转换行、`Material.kind` 取值同步更新 |

### 阶段二：模块命名与实现细节对齐

| # | 更新位置 | 文档原值 | 代码实际值 |
|---|---------|---------|-----------|
| 8 | Task 2 config.py | `PipelineConfig` | `RefineryConfig` |
| 9 | Task 2 config.py 字段 | 无 `mineru_token` | 新增 `mineru_token: str \| None` |
| 10 | Task 2 config.py 环境变量 | `CRAWLER_DATA_DIR` / `CRAWLER_OUTPUT_DIR` | `REFINERY_INPUT_DIR` / `REFINERY_OUTPUT_DIR` + `python-dotenv` 加载 `.env` |
| 11 | Task 4 checkpoint.py | `PipelineCheckpoint`，位于 `tools/crawler/src/core/checkpoint.py` | `RefineryCheckpoint`，位于 `tools/data-refinery/src/checkpoint.py` |
| 12 | 检查点文件名 | `.pipeline_checkpoint.json` | `.checkpoint.json` |
| 13 | Task 5 convert.py | 无重试、无 token 传递、保留 `-f md` | 重试机制（3 次/30s 延迟）、token 通过 env 传递、移除 `-f md` |
| 14 | Task 6 convert_cli.py | `pipeline.*` 导入、`PipelineConfig`、`--data-dir` | 扁平模块导入、`RefineryConfig`、`--input-dir` |
| 15 | Task 10 extract.py | `run()` 支持 `extra_context` 参数 | `run()` 不支持 `extra_context` |
| 16 | Task 11 MarkdownScanner | 在 `scanner.py` 内追加 | 独立文件 `markdown_scanner.py` |
| 17 | Task 12 extract_cli.py | 有 `extra_context` 页码上下文逻辑 | 移除 `extra_context` 逻辑 |
| 18 | Task 12 extract_cli.py 导入 | `pipeline.*` / `PipelineConfig` / `PipelineCheckpoint` / `--data-dir` | 扁平导入 / `RefineryConfig` / `RefineryCheckpoint` / `--input-dir` |
| 19 | 所有测试文件导入 | `from pipeline.xxx import ...` | `from xxx import ...`（扁平模块） |
| 20 | 目录结构图（Section 1.1） | 缺少 `markdown_scanner.py` | 已补全并标注各模块职责 |
| 21 | 自检清单 3.3 | `PipelineCheckpoint` 字段名一致 | `RefineryCheckpoint` 字段名一致 |
| 22 | 背景说明（line 17） | `mineru-open-api extract <file> -o <dir> -f md` | 标注 `-f md` 可选（默认即 md） |

### 阶段三：最终验证

通过 `grep` 全文扫描确认：

- `from pipeline.` / `import pipeline.` 引用：**0 处**
- `PipelineConfig` / `PipelineCheckpoint` 引用：**0 处**
- `--data-dir` 引用：**0 处**
- `extra_context` 引用：**0 处**
- `RefineryConfig` / `RefineryCheckpoint` 引用：**22 处**（正确）
- `--input-dir` 引用：**4 处**（正确）

---

## 三、未完成任务 / 遗留事项

### 3.1 实际测试文件与设计文档测试不一致（已修复 ✅）

| 文件 | 问题 | 状态 |
|------|------|------|
| `tools/data-refinery/tests/test_convert.py` line 22 | `TestMineruRunner.test_builds_extract_command` 仍断言 cmd 包含 `-f md`，但实际 `convert.py` 已移除该参数 | 已修复：删除断言中的 `-f md` |

### 3.2 `extract_cli.py` 检查点逻辑潜在 bug（已修复 ✅）

**现象**：教材输出为扁平结构，`书名/page_001.md`、`书名/page_002.md`、... 共享同一 `rel_path`（书名目录）。

**影响**：
- `extract_cli.py` line 71-74：`checkpoint.is_extracted(rel)` 在处理完第一页后将整个目录标记为已提取，后续页全部被 skip
- `extract_cli.py` line 80-82：所有页都写入同一个 `cards.jsonl`，后写覆盖前写

**后果**：教材卡片提取实际上只能处理第一页，整本书的卡片会丢失。

**采用修复**（方案 B，仅改 `extract_cli.py`，scanner 不动）：
- checkpoint key 改为文件级 `rel_file = source.rel_path / source.md_path.name`（如 `书名/page_001.md`），每页唯一
- 输出改为每份 md 镜像一个 `out_file = extracted_dir / rel_file.with_suffix(".jsonl")`（如 `page_001.jsonl`、`<试卷名>.jsonl`）
- 输出文件名由 `questions.jsonl`/`cards.jsonl` 统一改为按 md stem 镜像；kind 改由后续 publish/loader 按 source 判定
- 新增回归测试 `test_multi_page_textbook_writes_one_jsonl_per_page` 锁定该修复

**注意**：图片仍是 markdown 里的原始 `images/xxx.jpg` 相对路径，未做素材物化与路径改写——见 3.7 publish 阶段。

### 3.3 `extract_cli.py` 未传递页码上下文

设计文档原 Task 12 曾有 `extra_context` 逻辑，向 LLM 传递"文件名: page_NNN.md / 页码: N"，便于 `textbook_page` 字段提取。实际代码已移除该逻辑，导致 LLM 需自行从 Markdown 内容推断页码。

**建议**：若需要准确的 `textbook_page`，考虑在 `extract.py` 的 `Extractor.run()` 中重新加入 `extra_context` 参数，或在 prompt 模板中提示 LLM 从文件名推导。

### 3.4 设计文档 Task 2 缺少测试步骤

实际代码有 `tests/test_config.py`，但设计文档 Task 2 只有实现 + commit 两步，未写测试。如需文档完整覆盖，应补上测试代码块。

### 3.5 端到端验证（Task 15）部分未执行

设计文档 Task 15 的端到端验证清单：

| 步骤 | 状态 |
|------|------|
| Step 1: 安装依赖 | ✓ 已完成 |
| Step 2: 配置 `.env` | ✓ 已完成 |
| Step 3: convert dry-run | ✓ 已完成 |
| Step 4: 转换试卷（zgkao） | ✓ 已完成（全部 40 份素材已转换） |
| Step 5: 提取题目（extract） | ✗ **未执行** |
| Step 6: 检查 JSONL 格式 | ✗ **未执行** |
| Step 7: Commit 验证文档 | ✗ **未执行** |

### 3.6 提交（commit）状态

本次文档对齐工作尚未提交到 git。涉及修改的文件：

- `docs/文档转换设计.md`（大量更新）

建议提交信息：

```
docs(data-refinery): align design doc with actual implementation

- 教材输出结构改为扁平 page_NNN.md + 共享 images/
- 模块命名统一为 RefineryConfig / RefineryCheckpoint
- CLI 参数 --data-dir 改为 --input-dir
- convert.py 补充重试机制与 token 传递说明
- 移除 extract.py 的 extra_context 参数说明
- MarkdownScanner 独立为 markdown_scanner.py
- 更新所有 import 路径为扁平模块
```

### 3.7 extract 输出的图片与存储缺口（待 publish 阶段解决）

**现状**：`extract_cli.py` 输出的 `content`/`options`/`explanation` 里仍保留 mineru 原始图片相对路径 `![alt](images/xxx.jpg)`，指向 `output/md/<rel>/images/`。

**问题**：
1. 该路径相对 md 文件所在目录，web 服务未暴露该目录，无法服务图片
2. 未上传到对象存储/静态资源目录
3. 不符合数据库设计文档 §9 规范（`/assets/{questions|textbooks}/{subject}/{id}/stem_01.png`，DB 仅存相对路径，前端拼 `ASSET_BASE_URL`）
4. `cards.content_metadata.images[].url`、`questions.options[].image_url` 从未填充

**结论**：extract 与 Content Service 之间缺一个 publish（素材物化 + 路径改写 + 入库）阶段。详见 `docs/superpowers/plans/2026-07-12-data-refinery-publish-stage.md`。

---

## 四、后续建议优先级

| 优先级 | 任务 | 说明 |
|--------|------|------|
| ~~P0~~ | ✅ 修复 `test_convert.py` 的 `-f md` 断言 | 已修复 |
| ~~P0~~ | ✅ 修复 `extract_cli.py` 检查点/输出路径 bug | 已修复（方案 B，文件级 key + `<stem>.jsonl`） |
| P0 | 实现 publish 阶段（素材物化 + 路径改写 + DB 入库） | 否则图片无法被 web 服务、不符合 §9 规范；计划见 3.7 |
| P1 | 执行 extract pipeline 端到端验证 | Task 15 Step 5-7 |
| P2 | 补全 Task 2 测试步骤 | 文档完整性 |
| P2 | 评估是否需要恢复 `extra_context` 页码上下文 | 影响 `textbook_page` 字段准确性 |

---

## 五、相关文件清单

### 设计文档
- `docs/文档转换设计.md`（本次主要更新对象）

### 实际源码（已与文档对齐的参照基准）
- `tools/data-refinery/src/config.py`
- `tools/data-refinery/src/scanner.py`
- `tools/data-refinery/src/markdown_scanner.py`
- `tools/data-refinery/src/checkpoint.py`
- `tools/data-refinery/src/convert.py`
- `tools/data-refinery/src/convert_cli.py`
- `tools/data-refinery/src/extract.py`
- `tools/data-refinery/src/extract_cli.py`
- `tools/data-refinery/src/llm.py`
- `tools/data-refinery/src/models.py`

### 配置与环境
- `tools/data-refinery/.env`（含 `MINERU_TOKEN`，未提交）
- `tools/data-refinery/.env.example`
- `tools/data-refinery/requirements.txt`
- `tools/data-refinery/README.md`

### 输出目录
- `tools/data-refinery/output/md/`（已生成 40 份素材的 Markdown）
- `tools/data-refinery/output/extracted/`（待生成）
- `tools/data-refinery/output/.checkpoint.json`（断点续传记录）
