# 爬虫入口合并（crawler_cli.py）+ 学期判定修正 + 年级过滤

日期：2026-09-12
状态：待评审
关联模块：`tools/crawler/`

## 背景与问题

用户用旧入口抓取 `https://www.zgkao.com/shitiku/87761.html`（初三上学期期末试卷汇总）：

```bash
python ./src/main.py --url https://www.zgkao.com/shitiku/87761.html \
  --subject 数学 --year 2024,2025,2026 --output ./data
```

结果是这批**初三（上）期末**试卷全部落到了 `data/数学/初中/second/...`，
文件名也是 `数学-初三(下)-202507--2025学年-（上）期末考-试卷.pdf`（学期错、区县也错）。

调查发现五类问题：

### 问题 1：现有两个入口，逻辑重复

`tools/crawler` 有**两个** CLI 入口：

| 文件 | 作用 | 状态 |
| --- | --- | --- |
| `src/cli.py` | 新版多站点 CLI（`--site zgkao\|smartedu`） | README 推荐 |
| `src/main.py` | 旧版 zgkao 专用 CLI | 「向后兼容」 |

（`src/core/crawler.py` 是通用编排类，不是入口；`crawler_cli.py` 目前不存在。）

两者对 zgkao 是**重复实现**：`main.py` 自带一份 `Crawler` 类与 `_EXAM_TYPE_SEMESTER`，
`adapters/zgkao.py` 又存了一份同样的映射表。改一处漏一处，正是本次 bug 长期未暴露的原因之一。

### 问题 2：学期靠考试类型硬猜，且忽略页面上明确的上/下标记

`src/main.py:28-35` 与 `src/adapters/zgkao.py:12-19` 各有一份完全相同的映射表：

```python
_EXAM_TYPE_SEMESTER = {
    "一模": "second", "二模": "second", "三模": "second",
    "期末": "second",              # 期末被硬编码成下学期
    "期中": "first", "月考": "first",
}
```

取值处 `_EXAM_TYPE_SEMESTER.get(item.exam_type, "second")` 兜底也是 `second`。
实测 87761 页面表头解析出的 `exam_type` 是 `（上）期末考`，映射表里没有这个键 → 落到默认 `second`；
即便表头只写「期末」，按表也是 `second`。两条路都通向 `second`。

### 问题 3：该判定方式本身不成立

月考、期中、期末在**上下两个学期都有**，仅凭考试类型无法推断学期。
必须依赖页面/文件名中的上/下标记或月份；两者都没有时不能猜。

### 问题 4：区县被误解析

表头 `海淀区2024-2025学年初三（上）期末考试卷和答案汇总` 解析出的区县是 `-2025学年`
（正则第二组吃掉了「-2025学年」），导致文件名出现 `--2025学年-`。

### 问题 5：zgkao 无法按年级过滤

现有过滤维度只有 `--subject`/`--year`/`--district`；`--grade` 仅存在于 smartedu 教材线
（取值「九年级」），试卷线没有，用户无法「只下初三」。

### 测试盲区

`tests/adapters/test_zgkao_classifier.py` 所有用例都显式传 `semester="first"`，
从未覆盖 `_EXAM_TYPE_SEMESTER`；而该文件第 6 行的计划注释写的正是
`data/数学/初中/first/2026/数学-初三(上)-202607-西城-期末-试卷.pdf`——
设计意图本就是「期末 → 上」，实现与意图偏差且无测试兜底。

## 证据（2026-09-12 真实抓取）

`87761.html` 表头：

```
海淀区2024-2025学年初三（上）期末考试卷和答案汇总
2025-2026学年海淀区初二期末试卷&答案汇总
2025-2026学年北京海淀区初一期末试卷&答案汇总
```

对应源 PDF 文件名（记录在 `meta.json` 的 `source_url`）：

```
.../17682853386042026.01海淀区初三（上）期末数学.pdf
.../17362150366412025北京海淀初三（上）期末数学.pdf
.../17362311035582025北京海淀初二（上）期末数学   有答案.pdf
.../17363349864572025北京海淀初一（上）期末数学.pdf
```

初三表头含显式「（上）」；初二/初一表头只写「期末」，但 PDF 原名含「（上）」。当前代码两处信号都没用。

`89047.html`（二模）表头 18 条全部形如 `2026海淀初三二模试卷&答案`，无上/下标记；
PDF 文件名形如 `2026北京海淀初三二模数学   无答案.pdf`，无标记、无月份。

## 设计

### 1. 合并入口为 `src/crawler_cli.py`

新建 `tools/crawler/src/crawler_cli.py` 作为**唯一入口**，承载现有 `cli.py` 的多站点能力，
并补齐 zgkao 的年级过滤与学期判定：

```
python src/crawler_cli.py --site <zgkao|smartedu> [options]
```

- **删除** `src/main.py`、`src/cli.py`
- **删除** `src/core/storage.py` 里的 `Storage` 向后兼容包装（仅 `main.py` 使用），
  `test_storage.py` 中相关用例迁移到 `PdfStore.save`
- `tests/test_cli.py` → `tests/test_crawler_cli.py`
- `tests/adapters/test_zgkao.py` 中针对旧 `Crawler` 的用例迁移到 adapter + `core/crawler.py` 路径

参数（`--site` 必填，站点不支持的参数由现有校验拒绝）：

| 参数 | 站点 | 说明 |
| --- | --- | --- |
| `--url` | zgkao | 入口页 URL（必填） |
| `--subject` | 两者 | 学科过滤，逗号分隔多值 |
| `--year` | zgkao | 年份过滤，逗号分隔多值 |
| `--district` | zgkao | 区县过滤，逗号分隔多值 |
| `--grade` | 两者 | 年级过滤，逗号分隔多值（zgkao 用 `初一/初二/初三/高一/高二/高三`；smartedu 用 `九年级` 等） |
| `--level` / `--semester` / `--publisher` | smartedu | 学段 / 册次 / 版本过滤 |
| `--no-latest-only` | smartedu | 关闭「同书只取最新」 |
| `--output` / `--force` / `--dry-run` / `--crawl-delay` | 两者 | 通用 |

**破坏性变更**：`python src/main.py ...` 不再可用，须改为 `python src/crawler_cli.py --site zgkao ...`。
README 与用户手册同步更新。

### 2. 学期判定：`classifier.resolve_semester(...)`

纯函数，按优先级依次尝试，任一层确定即返回 `"first"` / `"second"`，全判不出返回 `None`：

| 优先级 | 依据 | 例子 | 结果 |
| --- | --- | --- | --- |
| ① | 索引页表头 `exam_type` 中的上/下标记 | `（上）期末考` | first |
| ② | PDF 文件名 / 试卷标题中的上/下标记 | `2025北京海淀初三（上）期末数学.pdf` | first |
| ③ | 模拟考约定：一模/二模/三模必属下学期 | `二模` | second |
| ④ | 文件名中的月份 | `2026.01海淀区初三期末数学.pdf` → 1 月 | first |
| ⑤ | 以上都无法判定 | — | `None`（交由调用方询问用户） |

标记识别接受 `（上）` / `(上)` / `上学期` / `第一学期`（同理「下」「第二学期」）；
**不匹配裸「上/下」字**，避免「上海」等误伤。

月份映射（仅取 ④，2/8 月跨学期不判）：

- `9、10、11、12、1` 月 → `first`
- `3、4、5、6、7` 月 → `second`
- `2、8` 月 → `None`（继续走 ⑤）

月份必须带分隔符或为连续 6 位，避免把 `2026北京海淀...` 的年份误读成月份：

- `(20\d{2})[.\-/年](\d{1,2})`
- 兜底 `(20\d{2})(0[1-9]|1[0-2])`

③ 的「模拟考」是一模/二模/三模的既有约定，与月考/期中/期末不同——
后者两学期都有，只走 ①/②/④，判不出就询问。

### 3. 判定不出时的行为（不猜、不静默丢数据）

- **交互式终端（stdin 是 TTY）**：当场提示并读取输入：

  ```
  无法从页面判断学期：初三-月考-2024（来源 .../xxx.pdf）
  请填写学期 [上/下]：
  ```

  接受 `上`/`first` → `first`，`下`/`second` → `second`。

- **两层缓存**（避免静默错归档与重复追问）：
  - **文件级**（key = 试卷详情页 URL）：自动推断成功的值只按「这一份试卷」复用。
    目的是让同一份试卷的「试卷/答案」两个文件落在同一学期（答案文件常缺标记），
    但**不跨试卷传播**——推断值不是证据，不能让 B 卷继承 A 卷的推断结果。
  - **组级**（group = `(年级, 考试类型, 年份)`）：只有**用户亲自回答过**的组才整组复用，
    同一组只问一次。这正是「本组剩余文件复用该答案」的授权范围。

  为什么必须分层：初三月考每年 9-12 月与 3-6 月各有一批。若把自动推断值也写进组缓存，
  同页里 A 校有月份证据（`2026.10…` → 上）就会让 B 校无任何证据的文件静默判成「上」，
  而 B 校真实可能是「下」——这正是本次要消灭的静默错归档。

- **非交互环境（管道 / CI）**：**跳过**判不出的文件（不写盘、不猜目录），
  逐条打印警告，运行结束汇总未决条目并以**非零退出码**结束。
- **`--dry-run`**：不触发询问、不因判不出失败（dry-run 不落盘），正常汇总输出。

明确**不新增 `--semester` 参数**：正常流程由程序从页面识别。

### 4. 区县解析修正（`parser._parse_header`）

保留现有正则对 `year`/`grade`/`exam_type` 的提取，仅修正 `district`：

1. 取中间片段 `mid`（年份与年级之间）
2. `mid` 含「学年」→ 区县 = 「学年」**之后**的文字（去空白）
3. 否则区县 = `mid`
4. 若仍为空 → 回退为年份**之前**的前缀文字
5. **去掉末尾的「区」**，统一口径

第 5 步是必需的：站点表头同时存在 `海淀区2024-2025学年初三…`（带「区」）与 `2026海淀初三二模…`（不带「区」）两种写法，
而 `--district` 过滤与文件名都是精确匹配（`adapters/zgkao.py` 的 `_passes_filter`、`classifier.filename()`），
不去「区」会让 `--district 海淀` 漏掉带「学年」的那批试卷。

实测四种形态：

| 表头原文 | mid | 命中规则 | 区县 |
| --- | --- | --- | --- |
| `海淀区2024-2025学年初三（上）期末考试卷和答案汇总` | `-2025学年` | 学年后为空 → 回退年份前缀 → 去「区」 | `海淀` |
| `2025-2026学年海淀区初二期末试卷&答案汇总` | `-2026学年海淀区` | 学年后 → 去「区」 | `海淀` |
| `2025-2026学年北京海淀区初一期末试卷&答案汇总` | `-2026学年北京海淀区` | 学年后 → 去「区」 | `北京海淀` |
| `2026海淀初三二模试卷&答案`（现有测试形态） | `海淀` | 无「学年」，无「区」可去 | `海淀`（不变） |

已知残留：带市名前缀的 `北京海淀` 与 `海淀` 仍是两种写法（站点原文本身不一致，不做市名归一化）。

### 5. 新增 `--grade` 过滤（zgkao）

- `crawler_cli.py`：`_ADAPTER_FILTERS["zgkao"]` 加入 `grades` 以放行校验；`_build_filters` 已是通用逻辑
- `adapters/zgkao.py`：`supported_filters()` 加 `grades`；`_passes_filter()` 比对 `item.grade`

### 6. 收敛重复实现

删除 `main.py` 的 `Crawler` 类与两份重复的 `_EXAM_TYPE_SEMESTER`；
学期判定统一由 `classifier.py` 提供：

- `resolve_semester(exam_type, title=None, filename=None) -> str | None`：纯函数，无副作用，便于单测
- `SemesterResolver(prompt_fn=None)`：负责两层缓存与询问；`prompt_fn=None` 即非交互
  `prompt_fn` 可注入（默认读 stdin），测试传 stub
- `ZgkaoAdapter` 接受 `semester_resolver` 参数，在 `_download_pdf` 构建分类前解析学期；
  返回 `None` 且非 dry-run 时，交互模式询问，非交互模式跳过并记录

### 7. 测试

- 学期判定：表头标记、文件名标记、一模/二模/三模、月份各分支（含 2/8 月 → `None`）、全判不出 → `None`
- 询问流程：判不出时调用 `prompt_fn`；**用户回答过的组**只问一次并整组复用；**自动推断值**只按同一份试卷复用、不跨试卷传播（两层缓存各一个测试）；stub 断言 `上/下` 映射
- 区县解析：§4 四种表头形态
- 年级过滤：`crawler_cli.py` 参数校验放行 `--grade`、adapter `_passes_filter`、非 zgkao 站点拒绝
- 入口合并：`crawler_cli.py` 的 `--site` 分发与参数校验（迁移自 `test_cli.py`）
- 迁移 `test_storage.py` 的 `Storage` 用例到 `PdfStore.save`；迁移 `test_zgkao.py` 的旧 `Crawler` 用例
- 全量 `pytest`（当前约 200 个）全绿

### 8. 文档同步（本次必做）

| 文档 | 改动 |
| --- | --- |
| `tools/crawler/README.md` | 入口改 `src/crawler_cli.py`；删除「旧版 CLI」章节；zgkao 参数表补 `--grade`；新增「学期判定」说明（自动识别 + 判不出询问）；输出结构示例体现 `first` |
| `docs/data-refinery-使用手册.md` | §3 入口与示例命令 `src/cli.py` → `src/crawler_cli.py`（约 118/135/143/161/170/626 行）；zgkao 参数表补 `--grade` |
| 本设计文档 | 实现后补「实现结果」小节 |
| `docs/superpowers/specs/2026-07-04-smartedu-textbook-crawler-design.md` | 顶部加一行变更说明：入口已合并为 `crawler_cli.py`（保留历史正文不改写） |
| `docs/superpowers/plans/2026-07-04-smartedu-textbook-crawler.md` | 同上，标注为历史计划 |

## 影响与迁移

- **旧命令失效**：`python src/main.py ...` → `python src/crawler_cli.py --site zgkao ...`
- **已下载数据的目录/文件名会变**：`second` 下的错误学期目录与 `--2025学年-` 错区县名需重跑或清理；
  重跑前建议清理对应 `meta.json` 与 checkpoint 条目
- **下游管线**：`tools/data-refinery` 默认输入 `tools/crawler/data`，目录结构契约
  `{base}/{subject}/{level}/{semester}/{year}/` 不变，仅学期归类更正确
- `docs/superpowers/plans/2026-09-02-training-module-1-foundation.md:172` 记录了爬虫命名契约，
  文件名格式不变（改的只是 district/semester 取值正确性），无需改

## 非目标

- 不修 `year_code` 固定拼 `07` 的问题（上学期期末实际应为 01 月），本次不动
- 不新增 `--semester` 参数
- 不改动 smartedu 线的既有行为（仅随入口合并搬迁）
- 不重写历史 spec/plan 正文

## 验收标准

1. `python src/crawler_cli.py --site zgkao --url https://www.zgkao.com/shitiku/87761.html --subject 数学 --grade 初三`：
   产物落在 `data/数学/初中/first/<年>/`，文件名学期为 `(上)`、区县为 `海淀`（不再是 `--2025学年`），
   且只下载初三（不再混入初一/初二）
2. 同一命令去掉 `--grade` 时，初一/初二的 `（上）期末` 也正确落到 `first`（靠 PDF 文件名标记）
3. `python src/crawler_cli.py --site zgkao --url https://www.zgkao.com/shitiku/89047.html`：
   二模行为与现状一致（`second`，区县 `海淀` 等），不触发任何询问
4. 构造一个无任何标记的 `期末` 页面：TTY 下提示填写学期且同组只问一次；
   非交互下跳过该文件、打印警告并以非零码退出
5. 全量 `pytest` 全绿；README / 用户手册 / 设计文档已同步

## 实现结果

（实现完成后填写：各 Task 提交号、`pytest` 通过数、87761 与 89047 两个入口页的真实落盘路径抽查结果。）
