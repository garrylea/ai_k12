# 试卷切题二维码图片过滤

- 日期：2026-09-12
- 状态：设计已与用户逐节确认
- 关联文档：`docs/superpowers/specs/2026-09-05-exam-question-splitter-design.md`（切题器，本设计在其前置加一道图片过滤器）、`docs/superpowers/specs/2026-07-29-image-dimension-and-card-splitting-design.md`（教材卡侧的小图标过滤，本设计镜像其做法）

## 1. 背景与问题

试卷（zgkao 来源）页面上带公众号「扫一扫」二维码。MinerU 把二维码切成独立小图，
下游切题逻辑把它当成题目配图，最终作为题目资源物化入库。

2026-09-12 实测现存语料：

| 指标 | 数值 |
| --- | --- |
| `output/assets/questions/` 中二维码资源 | **21 / 345**（解码内容均为 `http://weixin.qq.com/r/...`） |
| `output/published/` 中引用二维码资源的题 | **14 / 1698** |
| `output/assets/textbooks/` 中二维码资源 | **0 / 733**（教材卡无此问题） |

已发生的具体缺陷：

1. 一道「抽样调查方式」选择题，二维码被 `question_splitter._first_image_line_above`
   误挂成 **D 选项**配图（`opt_d.jpg` + `options[].image_url`），语义完全错误；
2. 多道题的二维码成为 `stem_01.jpg` / `stem_02.jpg`（题干配图）；
3. 一道题的二维码成为 `explain_01.jpg`（解析配图）。

教材卡路径本来就在 extract 阶段跑 `image_scan`，把小图标整行删掉
（`image_scan.py:87-97`，阈值 `_ICON_MAX_SCALED_HEIGHT = 78`）；试卷路径
**故意不跑** `image_scan`（`question_extract.py:7`「不跑 image_scan（保留所有图）」），
因此没有任何图片过滤环节。本设计给试卷路径补上**只针对二维码**的过滤器。

## 2. 目标与非目标

**目标**

1. 试卷切题前识别出二维码图片，并把它从题目内容中剔除（引用所在的整行删除）；
2. 保证「真实配图角落恰好带一个二维码」不会被整张误删；
3. 修复「二维码被误挂为选项配图」这一类缺陷的成因，而不只是事后擦除引用。

**非目标**

1. 不改教材卡路径（实测 733 张资源零二维码）；
2. 不清理已入库的存量数据（用户已确认本轮只改管线）；
3. 不做图片通用质检（模糊、空白、水印等），仅判二维码。

## 3. 方案可行性实测

用 `cv2.QRCodeDetector().detectAndDecode()`：

| 场景 | 结果 |
| --- | --- |
| 真实语料 4456 张图 | 62 张解码成功，全部是 `weixin.qq.com` 二维码，**零误判** |
| 594 张 80–260px 方形小图 | 558 张解不出，其中 **0 张**呈高黑白二值化（>97% 像素落在暗/亮两端）→ 是几何图形，不是漏检的二维码 |
| 独立二维码（真实语料） | 解码成功，二维码多边形占图面积 **0.86–0.93** |
| 合成独立二维码（`qrcode.make`，含 quiet zone） | 解码成功，占图面积 0.61 |
| **大图角落贴小二维码** | 解码成功，但占图面积仅 **0.0137** |
| 普通几何图形（圆 + 弦线） | 解码失败 |

两条结论：

1. **判定规则用「解码成功」而非图像特征**，普通插图不可能解出合法二维码载荷，
   误判率≈0；
2. 必须叠加「二维码占图面积 ≥ 阈值」护栏，否则「真实配图角落带二维码」会被整张误删
   （实测此类图占图仅 0.014，而真正的二维码图占 0.86+，分离度 60 倍）。

**阈值取 0.3**（用户已确认）：召回优先，与误删场景仍有 20 倍安全间隔，
且带 quiet zone 的合成二维码（0.61）也能通过。

## 4. 设计

### 4.1 过滤位置：extract 切题前（页级）

`question_extract.extract_questions_file` 现流程：

```
读 MD → normalize_fullwidth_parens → maybe_merge_answer_md（答案合并）
      → split_page（切题 + 答案对齐）→ Labeler（LLM 标注）→ split_options → 写 JSONL
```

过滤插在 `maybe_merge_answer_md` 之后、`split_page` 之前（`question_extract.py:173-176` 之间）：

```python
text = strip_qr_images(text, md_path.parent)
```

选此位置的四条理由：

1. **从成因上修掉误挂缺陷**：二维码行在切题前就消失，`split_options` 的
   `_first_image_line_above` 与 `abc_has_image` 不会再把它算作选项配图。
   若改在 publish 阶段过滤，同一张二维码已先被切成 D 选项的内容，只能事后擦除引用，
   成因仍在。
2. **一个钩子覆盖三条链路**：放在答案合并**之后**，使题干、选项、
   解析（`explain_01.jpg` 来自合并进来的答案 md）中的二维码引用一次性清掉。
3. **与既有架构一致**：教材卡在 extract 阶段用 `image_scan` 剔除装饰性小图标；
   本设计是试卷路径上的同类过滤器。`image_scan` 的阈值针对「渲染高度」，
   与二维码判定是两套正交规则，试卷路径仍不跑 `image_scan`，
   即「保留所有真实图」的语义不变。
4. **下游零改动**：`publish_cli` / `image_rewrite` / `db_loader` / `question_splitter`
   一行不改；`content_hash` 天然基于清洗后的 content 计算。
   目录解析也与 publish 一致（extract 用 `md_path.parent`，publish 用
   `md_dir / rel_file.parent`，指向同一目录）。

### 4.2 新模块 `src/qr_detect.py`

公开两个函数：

```python
def is_qr_code(disk_path: Path) -> bool:
    """解码成功且二维码多边形占图面积 ≥ 阈值 → True；读不到/解码失败/异常 → False。"""

def strip_qr_images(text: str, md_images_dir: Path) -> str:
    """删除 text 中二维码图片引用所在的整行；无命中则原样返回（保证幂等）。"""
```

实现约定：

- **读图用 `np.fromfile` + `cv2.imdecode(buf, cv2.IMREAD_COLOR)`，不用 `cv2.imread`**，
  避免中文路径（`output/md/数学/...`）在个别平台的编码差异；
  返回 `None` 一律视为非二维码。
- 面积比 = `cv2.contourArea(points.astype("float32")) / (W * H)`；
  `points is None`（未检测到）或 `data` 为空一律 False。
- `_qr_detector` 模块级构造一次复用（构造有开销）。
- 图片引用解析**复用 `image_scan._resolve_disk_path`**（已有三候选路径逻辑），
  避免第三份复制粘贴。
- 整行剔除镜像 `image_scan.scan_page` 的两遍式做法：先收集命中的 ref，
  再逐行剔除；逐行判断用 `IMAGE_REF_RE` 匹配（比 `image_scan` 里
  `f"![]({ref})"` 的写法更稳，兼容带 alt 的引用），末尾 `.strip()` 去掉首尾空行。

### 4.3 依赖

`requirements.txt` 新增 `opencv-python-headless>=4.8`
（当前环境是 conda 里的 `opencv-python` 4.11.0，未声明；headless 体积小、
无 GUI 依赖，适合批处理工具）。

> 注意：`opencv-python` 与 `opencv-python-headless` 都提供 `cv2` 模块，
> 同时安装存在覆盖关系。若 pip 安装出现冲突，改为声明
> `opencv-python>=4.8` 与本机现状一致即可。

测试不引入新依赖：二维码 fixture 取语料里一张真实小图（137×137 jpg）入库，
护栏用例用 PIL 把它贴到白底大画布上。

### 4.4 错误处理

判定失败一律**保守放过**（返回 False / 保留图片）：读不到文件、非图片字节、
解码异常、`points is None`。理由是与 `image_rewrite` 现有语义一致——
源文件缺失时保留原始引用，绝不因质检环节报错而丢内容。

## 5. 测试

新增 `tests/test_qr_detect.py` + fixture `tests/fixtures/qr_weixin.jpg`（真实语料二维码小图）。

`is_qr_code`：

- 真实二维码 fixture → True
- 二维码贴到 900×700 白底画布角落 → **False**（护栏关键用例）
- 合成的圆 + 弦几何图 → False
- 不存在的路径 → False
- 非图片字节（`b"fake"`）→ False

`strip_qr_images`：

- 二维码独占一行 → 该行被删，其余文本保留
- 真实配图引用 → 保留
- 源文件缺失的引用 → 保留（与 `image_rewrite` 语义一致）
- 带 alt 的引用 / 同一图多次引用 → 全部剔除
- 无命中 → 原样返回（不做 strip 改写，保证幂等）

集成回归（覆盖已发生的缺陷）：

- 用 FakeLLM（沿用 `tests/test_question_labeler.py` 的 inline FakeLLM 写法）
  + `tmp_path` 造一份试卷 md：一条题干 + A/B/C/D 选项，二维码图挂在 D 选项上方
  → 断言写出的 JSONL 中 `content`/`options` 均不含二维码 ref，
  且真实配图 ref 仍在

## 6. 存量数据（本轮不做）

已确认本轮只改管线，现存 14 道题的二维码留到下次全量重载时自然消失。
后续若要清理，注意入库环节的陷阱：content 变化 → `content_hash` 变化，
db_loader 的 upsert 不会更新旧行（会新插一条），而 full-reload 有业务数据守卫
（需 `--purge-business-data`，会清空 `main_error_books` 等学生数据，不可接受）。
推荐做法是按 `(questions.source, group_order)` 定位旧行**原地 UPDATE**
`content` / `content_metadata` 并重算 `content_hash`，保持 `questions.id` 不变，
错题本外键不受影响。

## 7. 影响文件

| 文件 | 改动 |
| --- | --- |
| `tools/data-refinery/src/qr_detect.py` | 新增（检测 + 整行剔除） |
| `tools/data-refinery/src/question_extract.py` | 加 import + 一行调用 + docstring 订正 |
| `tools/data-refinery/requirements.txt` | 加 `opencv-python-headless>=4.8` |
| `tools/data-refinery/tests/test_qr_detect.py` | 新增 |
| `tools/data-refinery/tests/fixtures/qr_weixin.jpg` | 新增（真实二维码小图 fixture） |

不改动：`publish_cli.py`、`image_rewrite.py`、`db_loader.py`、`question_splitter.py`、`image_scan.py`。
