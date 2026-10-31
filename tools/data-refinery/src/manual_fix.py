"""逐条引导人工补题：把识别漏掉的题目补回来，落到 manual_fixes/，稍后统一入库。

流程（对应 output/recognition_issues.jsonl 的 pending 项）：
1. 打印问题上下文：哪份卷、第几题、原 PDF 路径、md 路径、判定原因、可疑片段；
2. 人工给真题：粘贴 Markdown / 给图片路径（自动调 MinerU 转 md）/ 读本地文件；
3. 自动拆选项（走该学科策略）、可选填答案与材料；
4. 写入 output/manual_fixes/<卷名>.jsonl（status=ready），并把 issue 标 resolved。

入库不在这里做 —— 收集完之后跑 scripts/apply_fixes_cli.py。

入口：
    import_cli 第 7 步在 TTY 下自动调用 review_pending()；
    也可以单独跑 scripts/fix_question_cli.py（同一套逻辑）。
"""

import argparse
import getpass
import json
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

from subject_codes import subject_code_for_path  # noqa: E402
from subject_strategies import get_strategy  # noqa: E402

ISSUES_FILE = ROOT / "output" / "recognition_issues.jsonl"
FIXES_DIR = ROOT / "output" / "manual_fixes"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
MULTILINE_END = "EOF"


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    path.write_text(text, encoding="utf-8")


def _read_multiline() -> str:
    print(f"（粘贴 Markdown，结束后单独一行输入 {MULTILINE_END}）")
    lines = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line.strip() == MULTILINE_END:
            break
        lines.append(line)
    return "\n".join(lines).strip()


def _image_to_markdown(image: Path, paper_md_dir: Path) -> str:
    """调 MinerU 把图片转成 Markdown，并把产出的图片拷贝进该卷的 images/。"""
    from convert import MineruRunner

    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        MineruRunner().run([image], out)
        mds = sorted(out.glob("*.md"))
        if not mds:
            raise RuntimeError("MinerU 没有产出 Markdown")
        text = mds[0].read_text(encoding="utf-8").strip()
        # 图片引用是 images/<hash>.jpg，按同名拷到该卷目录，引用即可直接生效
        src_images = out / "images"
        if src_images.is_dir():
            dst = paper_md_dir / "images"
            dst.mkdir(parents=True, exist_ok=True)
            for img in src_images.iterdir():
                if not (dst / img.name).exists():
                    shutil.copy2(img, dst / img.name)
    return text


def _collect_content(issue: dict, paper_md_dir: Path) -> str | None:
    """读人工输入；返回 Markdown 正文，跳过时返回 None。"""
    first = input("> ").strip()
    if first in ("s", "S"):
        return None
    if first in ("q", "Q"):
        raise SystemExit(0)

    if first.startswith("@"):
        path = Path(first[1:]).expanduser()
        return path.read_text(encoding="utf-8").strip()

    candidate = Path(first).expanduser()
    if first and candidate.suffix.lower() in IMAGE_SUFFIXES and candidate.exists():
        print(f"[mineru] 正在把 {candidate.name} 转成 Markdown…", flush=True)
        text = _image_to_markdown(candidate, paper_md_dir)
        print("--- MinerU 结果 ---")
        print(text)
        print("--- 结果结束 ---")
        if input("用这段内容吗？[Y/n] ").strip().lower() in ("n", "no"):
            return _collect_content(issue, paper_md_dir)
        return text

    if first:
        # 单行输入当作题干首行，继续读到 EOF
        rest = _read_multiline()
        return "\n".join([first, rest]).strip() if rest else first
    return _read_multiline()


def _subject_of(issue: dict) -> str:
    rel = Path(issue["rel_path"])
    return subject_code_for_path(rel, default="") or "generic"


def _ask(issue: dict, paper_md_dir: Path) -> dict | None:
    subject = _subject_of(issue)
    strategy = get_strategy(subject)

    print("─" * 72)
    print(f"【{issue['source']}】第 {issue['group_order']} 题有问题")
    print(f"原文件：{issue.get('pdf') or '（未找到对应 PDF）'}")
    print(f"MD 文件：{issue.get('md')}")
    print(f"判定：{'；'.join(issue.get('reasons') or [])}")
    if issue.get("suspect_group_order"):
        print(f"疑点：题 {issue['suspect_group_order']} 可能吸收了本题内容")
    if issue.get("excerpt"):
        print("证据片段：")
        for line in issue["excerpt"].splitlines()[:12]:
            print("    " + line)
    print("─" * 72)
    print("请提供真题：1) 直接粘贴 Markdown（结束输入 EOF）"
          "  2) 图片路径（自动转 md）  3) @文件路径")
    print("             s) 跳过   q) 退出")

    content = _collect_content(issue, paper_md_dir)
    if content is None:
        return None

    stem, options = strategy.split_options(content)
    if options:
        print(f"[拆分] 题干 {len(stem)} 字，选项 {len(options)} 项："
              f"{[o['label'] for o in options]}")
    else:
        print(f"[拆分] 未识别出选项，整段作为题干（{len(content)} 字）")

    answer = input("答案（可留空）：").strip()
    record = {
        "source": issue["source"],
        "rel_path": issue["rel_path"],
        "group_order": issue["group_order"],
        "content": stem.strip(),
        "options": options,
        "answer": answer,
        "material_text": None,
        "issue_kind": issue["kind"],
        "issue_reasons": issue.get("reasons") or [],
        "pdf": issue.get("pdf"),
        "md": issue.get("md"),
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "operator": getpass.getuser(),
        "status": "ready",
        "applied": False,
    }
    print(f"[ok] 已记录：第 {record['group_order']} 题，{len(record['content'])} 字")
    return record


def pending_issues(sources: set[str] | None = None,
                   file: str | None = None) -> list[dict]:
    """取待处理的识别问题；sources 精确限定卷（import_cli 用），file 是卷名子串。"""
    issues = [i for i in _read_jsonl(ISSUES_FILE) if i.get("status") == "pending"]
    if sources is not None:
        issues = [i for i in issues if i["source"] in sources]
    if file:
        issues = [i for i in issues if file in i["source"]]
    return issues


def review_pending(sources: set[str] | None = None,
                   file: str | None = None,
                   *, list_only: bool = False,
                   fixes_dir: Path | None = None,
                   limit: int | None = None) -> dict:
    """逐条引导补题。返回 {"pending", "fixed", "skipped"}。

    list_only=True 只打印清单；fixes_dir 缺省 output/manual_fixes。
    """
    issues = pending_issues(sources, file)
    result = {"pending": len(issues), "fixed": 0, "skipped": 0}
    if not issues:
        print("[done] 没有待处理的问题", flush=True)
        return result

    if list_only:
        for i in issues:
            print(f"{i['source'][:34]} 题{i['group_order']:<3} {i['kind']:<16} "
                  f"{'；'.join(i.get('reasons') or [])}")
        print(f"共 {len(issues)} 条")
        return result

    all_issues = _read_jsonl(ISSUES_FILE)   # 写回时要用全量
    out_dir = Path(fixes_dir) if fixes_dir else FIXES_DIR
    for issue in issues[: limit] if limit else issues:
        paper_md_dir = Path(issue["md"]).parent if issue.get("md") else None
        if paper_md_dir is None:
            print(f"[skip] {issue['source']} 题{issue['group_order']}：缺 md 路径", flush=True)
            result["skipped"] += 1
            continue
        record = _ask(issue, paper_md_dir)
        if record is None:
            result["skipped"] += 1
            continue
        out_file = out_dir / f"{record['source']}.jsonl"
        rows = _read_jsonl(out_file)
        rows = [r for r in rows if r["group_order"] != record["group_order"]]
        rows.append(record)
        _write_jsonl(out_file, rows)

        for it in all_issues:
            if (it["source"] == issue["source"] and it["group_order"] == issue["group_order"]
                    and it["kind"] == issue["kind"]):
                it["status"] = "resolved"
                it["resolved_at"] = record["created_at"]
                it["fix_file"] = str(out_file)
        _write_jsonl(ISSUES_FILE, all_issues)
        result["fixed"] += 1

    print(f"\n[完成] 本次补了 {result['fixed']} 题，跳过 {result['skipped']} 条；"
          f"文件在 {out_dir}", flush=True)
    if result["fixed"]:
        print("下一步：python3 scripts/apply_fixes_cli.py --dry-run 预览，再 --apply 入库",
              flush=True)
    return result


def main() -> int:
    global ISSUES_FILE
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", help="卷名子串过滤，如 人大附中")
    parser.add_argument("--issues", default=str(ISSUES_FILE))
    parser.add_argument("--fixes-dir", default=str(FIXES_DIR))
    parser.add_argument("--list", action="store_true", help="只列清单，不进入交互")
    args = parser.parse_args()

    ISSUES_FILE = Path(args.issues)
    review_pending(file=args.source, list_only=args.list, fixes_dir=Path(args.fixes_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
