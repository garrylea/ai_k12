"""逐条引导人工补题：把识别漏掉的题目补回来，落到 manual_fixes/，稍后统一入库。

入口：
    import_cli 第 7 步在 TTY 下自动调用 review_pending()；
    也可以单独跑 scripts/fix_question_cli.py（同一套逻辑）。

一次交互的输入约定：
- 直接粘贴 Markdown，最后单独一行输入 `EOF`（大小写均可，也认 END / 结束）；
- 或输入图片路径（.png/.jpg/…），自动调 MinerU 转成 Markdown 并落图；
- 或输入 `@某个文件路径` 直接读取本地 md/txt；
- `s` 跳过本题，`q` 退出。

输入层用 `sys.stdin.readline()` 而不是 `input()`：终端把整段粘贴当一坨塞进来时
（bracketed paste），readline 会一次返回多行，旧实现只按行匹配 EOF，把标记连同
正文一起吞掉后继续等下一行 —— 用户看到的就是「加了 EOF 还卡住」。
"""

import getpass
import json
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from subject_codes import subject_code_for_path
from subject_strategies import get_strategy

ROOT = Path(__file__).resolve().parents[1]
ISSUES_FILE = ROOT / "output" / "recognition_issues.jsonl"
FIXES_DIR = ROOT / "output" / "manual_fixes"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_END_MARKERS = {"EOF", "END", "结束"}


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                    encoding="utf-8")


def _read_line(prompt: str = "") -> str | None:
    """读一行；输入流结束时返回 None（不抛 EOFError，避免半路崩栈）。"""
    if prompt:
        print(prompt, end="", flush=True)
    line = sys.stdin.readline()
    if line == "":
        return None
    return line.rstrip("\n")


def _split_at_marker(text: str) -> tuple[str, bool]:
    """按结束标记切开一段输入；返回 (标记之前的正文, 是否遇到标记)。

    一段输入可能是多行（终端整段粘贴时 readline 一次返回一坨），所以必须逐行扫，
    不能只看第一行。
    """
    kept: list[str] = []
    for line in text.splitlines():
        if line.strip().upper() in _END_MARKERS:
            return "\n".join(kept).strip(), True
        kept.append(line)
    return "\n".join(kept).strip(), False


def _read_block(first_chunk: str = "") -> str:
    """读到结束标记为止，返回正文；first_chunk 是已经读到的那一段。"""
    print("（粘贴 Markdown，结束后单独一行输入 EOF，大小写均可；s 跳过 / q 退出）",
          flush=True)
    body, done = _split_at_marker(first_chunk)
    lines = body.splitlines() if body else []
    while not done:
        chunk = sys.stdin.readline()
        if chunk == "":          # 输入流结束：当成正文到此为止，不卡死
            break
        body, done = _split_at_marker(chunk)
        if body:
            lines.extend(body.splitlines())
            if len(lines) % 10 == 0:
                print(f"  …已收到 {len(lines)} 行（输入 EOF 结束）", flush=True)
    print(f"[已收到 {len(lines)} 行]", flush=True)
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
        src_images = out / "images"
        if src_images.is_dir():
            dst = paper_md_dir / "images"
            dst.mkdir(parents=True, exist_ok=True)
            for img in src_images.iterdir():
                if not (dst / img.name).exists():
                    shutil.copy2(img, dst / img.name)
    return text


def _collect_content(paper_md_dir: Path) -> str | None:
    """读人工输入；返回 Markdown 正文，跳过时返回 None。"""
    while True:
        first = _read_line("> ")
        if first is None:
            return None
        first = first.strip()
        if first.lower() == "s":
            return None
        if first.lower() == "q":
            raise SystemExit(0)
        if first.startswith("@"):
            path = Path(first[1:]).expanduser()
            return path.read_text(encoding="utf-8").strip()
        if not first:
            return _read_block("")

        candidate = Path(first).expanduser()
        if candidate.suffix.lower() in IMAGE_SUFFIXES and candidate.exists():
            print(f"[mineru] 正在把 {candidate.name} 转成 Markdown…", flush=True)
            text = _image_to_markdown(candidate, paper_md_dir)
            print("--- MinerU 结果 ---")
            print(text)
            print("--- 结果结束 ---")
            if (_read_line("用这段内容吗？[Y/n] ") or "").strip().lower() in ("n", "no"):
                continue
            return text

        return _read_block(first)


def _subject_of(issue: dict) -> str:
    rel = Path(issue["rel_path"])
    return subject_code_for_path(rel, default="") or "generic"


def _ask(issue: dict, paper_md_dir: Path) -> dict | None:
    strategy = get_strategy(_subject_of(issue))

    print("─" * 72, flush=True)
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

    content = _collect_content(paper_md_dir)
    if content is None:
        return None
    if not content.strip():
        print("[跳过] 内容为空，未记录", flush=True)
        return None

    stem, options = strategy.split_options(content)
    if options:
        print(f"[拆分] 题干 {len(stem)} 字，选项 {len(options)} 项："
              f"{[o['label'] for o in options]}", flush=True)
    else:
        print(f"[拆分] 未识别出选项，整段作为题干（{len(content)} 字）", flush=True)

    answer = (_read_line("答案（可留空）：") or "").strip()
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
    print(f"[ok] 已记录：第 {record['group_order']} 题，{len(record['content'])} 字", flush=True)
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
    """逐条引导补题。返回 {"pending", "fixed", "skipped"}。"""
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
    for issue in (issues[:limit] if limit else issues):
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
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--source", help="卷名子串过滤，如 人大附中")
    parser.add_argument("--fixes-dir", default=str(FIXES_DIR))
    parser.add_argument("--list", action="store_true", help="只列清单，不进入交互")
    args = parser.parse_args()

    review_pending(file=args.source, list_only=args.list, fixes_dir=Path(args.fixes_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
