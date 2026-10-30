"""切题行为黄金快照：重构前拍基线，重构后逐份比对题数与题干哈希。

用法（在 tools/data-refinery/ 下）：
    python3 scripts/split_snapshot.py --write     # 写 tests/fixtures/split_snapshot.json
    python3 scripts/split_snapshot.py --check     # 比对当前代码与基线，有差异退出码 1
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from question_splitter import split_page  # noqa: E402
from subject_codes import subject_code_for_path  # noqa: E402
from subject_strategies import get_strategy  # noqa: E402

SAMPLE_PER_SUBJECT = 8
BASELINE = ROOT / "tests" / "fixtures" / "split_snapshot.json"


def sample_files(md_root: Path) -> list[Path]:
    """每个学科等距抽 SAMPLE_PER_SUBJECT 份试卷，顺序稳定（按路径排序后取步长）。

    只收文件名含「试卷」的 md：教科书单页（``page_001.md``）切不出题，纳入基线
    只会得到 count=0 的空断言，削弱回归网。
    """
    by_subject: dict[str, list[Path]] = {}
    for path in sorted(md_root.rglob("*.md")):
        if "试卷" not in path.name:
            continue
        code = subject_code_for_path(path.relative_to(md_root), default="math")
        by_subject.setdefault(code, []).append(path)
    picked: list[Path] = []
    for code in sorted(by_subject):
        paths = by_subject[code]
        step = max(1, len(paths) // SAMPLE_PER_SUBJECT)
        picked.extend(paths[::step][:SAMPLE_PER_SUBJECT])
    return picked


def snapshot(md_root: Path) -> dict:
    snap: dict = {}
    for path in sample_files(md_root):
        rel = str(path.relative_to(md_root))
        code = subject_code_for_path(path.relative_to(md_root), default="math")
        questions = split_page(
            path.read_text(encoding="utf-8"), path,
            strategy=get_strategy(code),
        )
        snap[rel] = {
            "count": len(questions),
            "items": [
                {"no": q.group_order,
                 "hash": hashlib.sha1(q.content.encode("utf-8")).hexdigest()[:12],
                 "mat": hashlib.sha1((q.material_text or "").encode("utf-8")).hexdigest()[:12],
                 "gid": q.group_id,
                 "score": q.score}
                for q in questions
            ],
        }
    return snap


# 差异行里字段的固定顺序（便于逐份对齐阅读）；不在此列的键排在后面。
_ITEM_FIELDS = ("no", "gid", "score", "hash", "mat")


def _describe_item_diff(base_item: dict, cur_item: dict) -> str:
    """只报变了的字段，避免整份 dict 打印两遍看不清哪里变了。"""
    keys = [k for k in _ITEM_FIELDS if k in base_item or k in cur_item]
    keys += sorted((set(base_item) | set(cur_item)) - set(keys))
    return ", ".join(
        f"{k} {base_item.get(k)!r} -> {cur_item.get(k)!r}"
        for k in keys if base_item.get(k) != cur_item.get(k)
    )


def compare(current: dict, baseline: dict) -> list[str]:
    """逐份比对，返回人类可读的差异行（空列表 = 完全一致）。

    整条 item dict 比对（题号 / 题干哈希 / 材料哈希 / 分组 / 分值全覆盖），
    差异行只列出变动的字段。
    """
    diffs: list[str] = []
    for rel in sorted(set(current) | set(baseline)):
        if rel not in current:
            diffs.append(f"{rel}: 基线有、当前缺失")
            continue
        if rel not in baseline:
            diffs.append(f"{rel}: 基线没有、当前多出")
            continue
        cur, base = current[rel], baseline[rel]
        if cur["count"] != base["count"]:
            diffs.append(f"{rel}: 题数 {base['count']} -> {cur['count']}")
            continue
        for i, (c, b) in enumerate(zip(cur["items"], base["items"])):
            if c != b:
                diffs.append(f"{rel}: 第 {i + 1} 项 {_describe_item_diff(b, c)}")
    return diffs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--md-root", default=str(ROOT / "output" / "md"))
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    md_root = Path(args.md_root)
    current = snapshot(md_root)
    if args.write:
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(current, ensure_ascii=False, indent=1, sort_keys=True),
                            encoding="utf-8")
        print(f"[ok] 基线已写入 {BASELINE}（{len(current)} 份）")
        return 0

    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    diffs = compare(current, baseline)
    if diffs:
        print(f"[FAIL] {len(diffs)} 处差异：")
        for line in diffs[:50]:
            print("  " + line)
        return 1
    print(f"[ok] {len(baseline)} 份快照零差异")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
