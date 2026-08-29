"""toc_parse 子命令入口。扫描教材 MD 目录，找目录页，LLM 解析为结构化 TOC JSON。"""

import argparse
import json
from pathlib import Path

from checkpoint import RefineryCheckpoint
from config import RefineryConfig
from llm import create_llm_client
from extract import _parse_json_object
from extract_cli import _load_prompt


# ---- 教材目录识别 ----

_EXAM_DIR_MARKERS = {"second", "first"}  # zgkao 试卷路径第 4 段是学年，第 3 段是 second/first


def _is_textbook_dir(parts: tuple[str, ...]) -> bool:
    """判断 MD 子目录是否为教材（非试卷）。

    教材路径：{subject}/{grade_band}/{publisher}/{grade}/{term}
    试卷路径：{subject}/{grade_band}/second/{year}/{exam_name}
    区分规则：第 3 段（索引 2）不是纯数字年份且不是 "second"/"first" → 教材。
    """
    if len(parts) < 5:
        return False
    level3 = parts[2]
    # 试卷路径第 3 段是 "second" 或 "first"，第 4 段是年份数字
    if level3 in _EXAM_DIR_MARKERS:
        return False
    if level3.isdigit():
        return False
    return True


# ---- 年级/学期简写展开 ----

_SHORT_GRADE = {
    "一": "一年级", "二": "二年级", "三": "三年级",
    "四": "四年级", "五": "五年级", "六": "六年级",
    "七": "七年级", "八": "八年级", "九": "九年级",
    "1": "一年级", "2": "二年级", "3": "三年级",
    "4": "四年级", "5": "五年级", "6": "六年级",
    "7": "七年级", "8": "八年级", "9": "九年级",
}
_SHORT_TERM = {"上": "上册", "下": "下册"}


def _expand_grade_term(raw: str) -> tuple[str | None, str | None]:
    """将用户输入的"九上"、"九年级上册"、"9,上册"等展开为 (grade, term)。

    支持格式：
    - "九上" → ("九年级", "上册")
    - "九年级上册" → ("九年级", "上册")
    - "九年级/上册" → ("九年级", "上册")
    - "九,上" → ("九年级", "上册")
    - "九年级" → ("九年级", None)
    - "上册" → (None, "上册")
    """
    raw = raw.replace("/", "").replace(",", "").replace("，", "").strip()
    # 尝试匹配 "X年级Y册" 格式
    for short, full in _SHORT_GRADE.items():
        if short in raw:
            grade = full
            rest = raw.replace(short, "").replace(full, "")
            for st, ft in _SHORT_TERM.items():
                if st in rest:
                    return (grade, ft)
            # 检查 rest 是否含"年级"
            if "年级" in rest:
                rest_no_grade = rest.replace("年级", "")
                for st, ft in _SHORT_TERM.items():
                    if st in rest_no_grade:
                        return (grade, ft)
            return (grade, None)
    # 只有学期
    for st, ft in _SHORT_TERM.items():
        if st in raw:
            return (None, ft)
    # 已是完整格式（如"九年级/上册" via --book）
    if "年级" in raw and "册" in raw:
        for st, ft in _SHORT_TERM.items():
            if st in raw:
                grade_part = raw.replace(ft, "").replace(st, "")
                return (grade_part.strip("/"), ft)
    return (raw if raw else None, None)


# ---- 目录页查找 ----

import re

# 目录行模式：编号标题 + 行末数字（教材页码）
_TOC_LINE_RE = re.compile(
    r'^\s*(第[一二三四五六七八九十百零]+章.*\d+\s*$'   # 第N章 X 页码
    r'|\d+\.\d+.*\d+\s*$'                             # N.M X 页码
    r'|.*(小结|复习题|数学活动|阅读与思考).*\d+\s*$)'    # 非编号条目+页码
)
# 正文页标志：长段落、教学模块标题
_BODY_MARKER_RE = re.compile(
    r'^[^#\d!].{60,}$'              # 60字符以上的非标题非图片行
    r'|##\s*(思考|练习|例\d|习题|复习巩固|探究|问题)'
)


def _is_toc_like_page(page_path: Path) -> bool:
    """判断一页是否像目录页：
    - 多数行是短行，带编号标题+行末页码
    - 没有长正文段落
    - 没有教学模块标题（思考/练习/例/习题等）
    """
    text = page_path.read_text(encoding="utf-8")
    lines = [l.strip() for l in text.splitlines()
             if l.strip() and not l.startswith("!")]
    if not lines:
        return False
    toc_lines = sum(1 for l in lines if _TOC_LINE_RE.search(l))
    body_lines = sum(1 for l in lines if _BODY_MARKER_RE.search(l))
    if body_lines > 0:
        return False
    # 至少 30% 的行匹配目录模式
    return toc_lines >= len(lines) * 0.3


def _find_toc_pages(book_dir: Path, max_pages: int = 10) -> list[Path]:
    """在教材 MD 目录中找所有目录页（含跨页续页）。

    策略：
    1. 前 max_pages 页中找包含"目录"标题的页（锚点）
    2. 从最后一个锚点向后扫描，收集连续的目录续页
    3. 续页判断：内容模式匹配（编号+页码），非正文
    4. 前 10 页找不到锚点则扩展到 20 页
    """
    mds = sorted(book_dir.glob("page_*.md"))
    if not mds:
        return []

    candidates = mds[:max_pages]
    anchors = [i for i, p in enumerate(candidates) if "目录" in p.read_text(encoding="utf-8")]

    if not anchors:
        if max_pages == 10:
            return _find_toc_pages(book_dir, max_pages=20)
        return []

    # 从最后一个锚点开始，向后收集续页
    start = anchors[-1]
    toc_pages = [candidates[start]]

    for p in candidates[start + 1:]:
        if _is_toc_like_page(p):
            toc_pages.append(p)
        else:
            break  # 遇到非目录页即停止

    return toc_pages


# ---- CLI ----

def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="从教材目录页 LLM 提取章节结构",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python src/toc_parse_cli.py                                         # 扫描所有教材
  python src/toc_parse_cli.py --grade 九上                             # 九年级上册（简写）
  python src/toc_parse_cli.py --subject 数学 --publisher 人教版         # 指定学科+版本
  python src/toc_parse_cli.py --book "九年级/下册"                     # 路径子串匹配
  python src/toc_parse_cli.py --dry-run                               # 试运行
  python src/toc_parse_cli.py --reconvert --grade 九下                 # 重新解析指定教材
  python src/toc_parse_cli.py --reconvert                              # 重新解析所有教材
        """,
    )
    parser.add_argument("--input-dir", help="MD 目录（默认 output/md）")
    parser.add_argument("--output-dir", help="TOC JSON 输出目录（默认 output/toc）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="smartedu",
                        help="素材来源过滤（默认 smartedu，只有教材有目录）")
    parser.add_argument("--subject", help="学科过滤（如 数学、语文）")
    parser.add_argument("--publisher", help="出版社过滤（如 人教版）")
    parser.add_argument("--grade", help="年级过滤，支持简写：九上→九年级上册、9上→九年级上册")
    parser.add_argument("--term", help="学期过滤：上册、下册（与 --grade 配合；简写如'九上'已含学期则无需单独指定）")
    parser.add_argument("--book", help="只处理指定教材（路径子串匹配，如'九年级/下册'）")
    parser.add_argument("--reconvert", action="store_true",
                        help="清除 checkpoint + 删除已有 TOC JSON，重新解析")
    parser.add_argument("--dry-run", action="store_true",
                        help="只打印将要处理的目录页")
    return parser.parse_args(argv)


def _match_source(rel: str, source: str) -> bool:
    """判断路径是否匹配来源过滤。"""
    if source == "all":
        return True
    *_, name = rel.replace("\\", "/").split("/")
    if source == "zgkao":
        return "试卷" in name or "答案" in name
    if source == "smartedu":
        return "试卷" not in name and "答案" not in name
    return False


def _build_textbook_list(md_dir: Path, args) -> list[Path]:
    """构建待处理的教材目录列表，依次应用所有过滤条件。"""
    # 扫描 6 级深度：{subject}/{grade_band}/{publisher}/{grade}/{term}/{book}
    # 教材目录结构包含书名目录，试卷也匹配此深度
    all_dirs = sorted(md_dir.glob("*/*/*/*/*/*"))
    textbooks: list[Path] = []

    # 跳过含隐藏目录的路径（如 .DS_Store 出现在任意层级）
    all_dirs = [d for d in all_dirs if not any(p.startswith(".") for p in d.parts)]

    grade_filter: str | None = None
    term_filter: str | None = None

    # 解析 --grade 简写
    if args.grade:
        grade_filter, term_from_grade = _expand_grade_term(args.grade)
        if term_from_grade and not args.term:
            term_filter = term_from_grade
    if args.term:
        term_filter = args.term

    for d in all_dirs:
        rel = str(d.relative_to(md_dir))
        parts = tuple(rel.replace("\\", "/").split("/"))

        # 1. 只处理教材（非试卷）
        if not _is_textbook_dir(parts):
            continue

        # 2. 来源过滤
        if not _match_source(rel, args.source):
            continue

        # 3. 学科过滤
        if args.subject and parts[0] != args.subject:
            continue

        # 4. 出版社过滤（路径第 3 段）
        if args.publisher and parts[2] != args.publisher:
            continue

        # 5. 年级过滤（路径第 4 段）
        if grade_filter and parts[3] != grade_filter:
            continue

        # 6. 学期过滤（路径第 5 段）
        if term_filter and parts[4] != term_filter:
            continue

        # 7. book 子串匹配
        if args.book and args.book not in rel:
            continue

        textbooks.append(d)

    return textbooks


def main(argv=None):
    args = parse_args(argv)
    config = RefineryConfig.from_env(input_dir=None, output_dir=args.output_dir or None)
    md_dir = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    toc_dir = Path(args.output_dir) if args.output_dir else config.output_dir / "toc"

    checkpoint = RefineryCheckpoint(config.output_dir / ".toc_checkpoint.json")
    checkpoint.load()

    book_dirs = _build_textbook_list(md_dir, args)

    if args.dry_run:
        if not book_dirs:
            print("[dry-run] 未找到匹配的教材目录。提示：", flush=True)
            print("  教材路径格式：{学科}/{学段}/{出版社}/{年级}/{册次}/", flush=True)
            print("  如：数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册", flush=True)
            print(f"  共扫描 {len(sorted(md_dir.glob('*/*/*/*/*')))} 个目录，"
                  f"其中教材 {len(book_dirs)} 个", flush=True)
        for d in book_dirs:
            pages = _find_toc_pages(d)
            status = f"→ {len(pages)} toc page(s)" if pages else "→ 未找到目录页"
            print(f"[dry-run] {d.relative_to(md_dir)} {status}", flush=True)
        return

    llm = create_llm_client(
        provider=config.llm_provider, api_key=config.llm_api_key or "",
        auth_token=config.llm_auth_token, model=config.llm_model,
        base_url=config.llm_base_url, timeout=config.llm_timeout,
        max_tokens=config.llm_max_tokens, max_retries=config.llm_max_retries,
        thinking=config.llm_thinking, enable_cache=config.llm_enable_cache,
    )
    prompt = _load_prompt("toc_parse")

    parsed = skipped = failed = 0

    # --reconvert 预处理：清理匹配教材的 checkpoint + 旧 JSON
    if args.reconvert:
        cleared = 0
        for book_dir in book_dirs:
            book_key = str(book_dir.relative_to(md_dir))
            if checkpoint.is_toc_parsed(book_key):
                checkpoint.unmark_toc_parsed(book_key)
                cleared += 1
            out_file = toc_dir / f"{book_key}.json"
            if out_file.exists():
                out_file.unlink()
        if cleared:
            print(f"[reconvert] cleared checkpoint for {cleared} book(s)", flush=True)

    for book_dir in book_dirs:
        toc_pages = _find_toc_pages(book_dir)
        if not toc_pages:
            print(f"[WARN] {book_dir.relative_to(md_dir)}: no toc pages found", flush=True)
            continue

        book_key = str(book_dir.relative_to(md_dir))

        if not args.reconvert and checkpoint.is_toc_parsed(book_key):
            skipped += 1
            print(f"[skip] {book_key}", flush=True)
            continue

        # LLM 输出解析：_parse_json_object 已兜底代码块围栏 / <think> 标签 /
        # LaTeX 反斜杠漏转义（本地模型常见，如 "\%"）；仍失败则重采样一次
        data = None
        try:
            toc_text = "\n\n".join(p.read_text(encoding="utf-8") for p in toc_pages)
            response = llm.complete(prompt, toc_text)
            data = _parse_json_object(response.content)
        except json.JSONDecodeError as e:
            print(f"[WARN] {book_key}: LLM 输出 JSON 解析失败（{e}），重试一次", flush=True)
            try:
                response2 = llm.complete(prompt, toc_text)
                data = _parse_json_object(response2.content)
            except Exception as e2:
                print(f"[ERROR] {book_key}: retry also failed: {e2}", flush=True)
        except Exception as e:
            print(f"[ERROR] {book_key}: {e}", flush=True)

        if not isinstance(data, dict) or not data:
            failed += 1
            continue

        out_file = toc_dir / f"{book_key}.json"
        out_file.parent.mkdir(parents=True, exist_ok=True)
        out_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

        checkpoint.mark_toc_parsed(book_key)
        chapters = len(data.get("chapters", []))
        print(f"[ok] {book_key} -> {chapters} chapter(s)", flush=True)
        parsed += 1

    print(f"TOC parsed: {parsed}, Skipped: {skipped}, Failed: {failed}", flush=True)


if __name__ == "__main__":
    main()
