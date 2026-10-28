"""answer_extract_cli：按学科提取试卷答案，产出 answer_importer 可消费的答案文档。

两段式回写（答案只提取不生成）：
    1) 本 CLI：试卷 md → 分学科 case 提取 → 规范答案文档（Markdown）
    2) answer_importer_cli --doc <文档> --paper-id <id>：写回 questions.answer/explanation

用法（cd tools/data-refinery）：
    python src/answer_extract_cli.py --file "202507-海淀-模拟二-试卷"            # 生成到 output/answers/
    python src/answer_extract_cli.py --file "..." --dry-run                       # 只看统计不写文件
    python src/answer_extract_cli.py --file "..." --subject chinese --out /tmp/a.md

学科默认从路径首段识别（语文/数学/…），识别不了要显式 --subject；
各学科走 subject_cases 里各自的函数，互不影响。
"""

import argparse
import json
import sys
from pathlib import Path

from config import RefineryConfig
from paper_meta import parse_paper_meta
from subject_cases import UnknownSubjectError, detect_subject, get_case

DEFAULT_ISSUES_FILE = "answer_issues.jsonl"


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="按学科提取试卷答案，输出 answer_importer 答案文档")
    p.add_argument("--file", required=True, help="试卷 md 的相对路径子串（须唯一命中）")
    p.add_argument("--out", help="输出文档路径（默认 output/answers/<卷名>.md）")
    p.add_argument("--subject", help="学科 code（默认按路径首段识别）")
    p.add_argument("--input-dir", help="md 输入根目录（默认 output/md）")
    p.add_argument("--output-dir", help="输出根目录（默认 output）")
    p.add_argument("--dry-run", action="store_true", help="只打印统计与预览，不写文件")
    return p.parse_args(argv)


def find_paper_md(md_dir: Path, keyword: str) -> Path | None:
    """按相对路径子串找唯一试卷 md；命中多个/0 个打印候选并返回 None。"""
    hits = [p for p in sorted(md_dir.rglob("*.md")) if keyword in str(p.relative_to(md_dir))]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        print(f"错误：未找到匹配「{keyword}」的 md", file=sys.stderr)
        return None
    print(f"错误：「{keyword}」命中 {len(hits)} 个文件，请缩小范围：", file=sys.stderr)
    for h in hits:
        print(f"  {h.relative_to(md_dir)}", file=sys.stderr)
    return None


def paper_title(rel_md: Path, text: str) -> str:
    """优先用文件名元数据（与 exam_papers.title 同源），否则取首个标题行。"""
    meta = parse_paper_meta(str(rel_md.with_suffix(".jsonl")))
    if meta:
        return meta.title
    for line in text.splitlines():
        stripped = line.strip().lstrip("#").strip()
        if stripped:
            return stripped
    return rel_md.stem


def render_answer_doc(title: str, answers) -> str:
    """按 answer_doc.py 的格式渲染（空答案题不写，避免文档校验失败）。"""
    parts = [f"# 试卷：{title}", ""]
    for item in answers:
        answer = (item.answer or "").strip()
        if not answer:
            continue
        lines = [ln.lstrip("#").rstrip() for ln in answer.split("\n") if ln.strip()]
        parts.append(f"## {item.no}")
        parts.append("答案：" + lines[0])
        parts.extend(lines[1:])
        if (item.explanation or "").strip():
            parts.append("解析：" + item.explanation.strip().split("\n")[0])
            for ln in item.explanation.strip().split("\n")[1:]:
                if ln.strip():
                    parts.append(ln.rstrip())
        parts.append("")
        parts.append("---")
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"


def write_issues(path: Path, source: str, answers) -> int:
    rows = [
        {"source": source, "question_no": a.no, "reason": reason}
        for a in answers for reason in a.issues
    ]
    if not rows:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(rows)


def main(argv=None) -> int:
    args = parse_args(argv)
    config = RefineryConfig.from_env(input_dir=None, output_dir=None)
    md_dir = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    out_root = Path(args.output_dir) if args.output_dir else config.output_dir

    md_path = find_paper_md(md_dir, args.file)
    if md_path is None:
        return 2
    rel_md = md_path.relative_to(md_dir)

    subject = args.subject or detect_subject(rel_md)
    try:
        case = get_case(subject)
    except UnknownSubjectError as e:
        print(f"错误：{e}", file=sys.stderr)
        return 2

    text = md_path.read_text(encoding="utf-8")
    answers = case(text, md_path)

    with_answer = [a for a in answers if (a.answer or "").strip()]
    issue_count = sum(len(a.issues) for a in answers)
    print(f"学科：{subject}")
    print(f"提取：{len(answers)} 题，有答案 {len(with_answer)} 题，issues {issue_count} 条")
    for a in answers:
        for reason in a.issues:
            print(f"  [issue] {reason}")

    doc = render_answer_doc(paper_title(rel_md, text), answers)
    if args.dry_run:
        print("\n--- dry-run 预览（前 30 行）---")
        print("\n".join(doc.splitlines()[:30]))
        return 0

    out_path = Path(args.out) if args.out else out_root / "answers" / f"{rel_md.stem}.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(doc, encoding="utf-8")
    written_issues = write_issues(out_root / DEFAULT_ISSUES_FILE, str(rel_md), answers)
    print(f"已写入：{out_path}")
    if written_issues:
        print(f"issues 已追加：{out_root / DEFAULT_ISSUES_FILE}（{written_issues} 条）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
