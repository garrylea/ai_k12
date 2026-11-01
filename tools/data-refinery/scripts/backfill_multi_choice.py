"""把「多项选择题」大题里的题改成 multi_choice（一次性回填，幂等）。

卷面的大题标题是唯一依据：`二、多项选择题（…）` 之后、下一个大题标题之前的题号，
全部改成 multi_choice。不改内容、不改答案，只改 `questions.type`。

用法：
    python3 scripts/backfill_multi_choice.py --dry-run
    python3 scripts/backfill_multi_choice.py --apply
"""

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import pymysql  # noqa: E402

from config import RefineryConfig  # noqa: E402

MD_ROOT = ROOT / "output" / "md"
GROUP_RE = re.compile(r"(?m)^#{0,6}\s*([一二三四五六七八九十]+)、")
STEM_RE = re.compile(r"(?m)^\s*(\d{1,2})\s*[.．]\s*\S")
ANSWER_RE = re.compile(r"(?m)^#{0,6}\s*(参考答案|答案及评分|评分参考)")


def multi_numbers(md_text: str) -> set[int]:
    """找出「多项选择题」大题覆盖的题号集合。

    不能直接用这一节里扫到的题号：OCR 会把「16.」认成「6.」（人大附实测），
    按题号采样会把第 6 题（前一大题的单选）误伤。改用区间：
    起点 = 本大题之前出现过的最大题号 + 1，终点 = 本节内最大题号。
    """
    nums: set[int] = set()
    headers = list(GROUP_RE.finditer(md_text))
    for i, m in enumerate(headers):
        # 标题行要从匹配末尾所在行取：`^` 命中的可能是一个空行，
        # `\s*` 把换行吃掉了，直接用 m.start() 会只拿到 "\n"。
        line_start = md_text.rfind("\n", 0, m.end()) + 1
        line_end = md_text.find("\n", m.end())
        line = md_text[line_start: line_end if line_end != -1 else len(md_text)]
        if "多项选择" not in line:
            continue
        start = m.end()
        end = headers[i + 1].start() if i + 1 < len(headers) else len(md_text)
        ans = ANSWER_RE.search(md_text, start)
        if ans and ans.start() < end:
            end = ans.start()
        before = [int(x.group(1)) for x in STEM_RE.finditer(md_text, 0, start)]
        inside = [int(x.group(1)) for x in STEM_RE.finditer(md_text, start, end)]
        first = (max(before) if before else 0) + 1
        last = max(inside) if inside else 0
        nums.update(range(first, last + 1))
    return nums


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name,
                           charset="utf8mb4", autocommit=False)
    total = 0
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, source_key FROM exam_papers")
            papers = cur.fetchall()
            for paper_id, key in papers:
                md = MD_ROOT / f"{key}.md"
                if not md.exists():
                    continue
                nums = multi_numbers(md.read_text(encoding="utf-8", errors="ignore"))
                if not nums:
                    continue
                fmt = ",".join(str(n) for n in sorted(nums))
                cur.execute(
                    "SELECT q.id, pq.question_no, q.type FROM paper_questions pq "
                    "JOIN questions q ON q.id = pq.question_id "
                    f"WHERE pq.paper_id=%s AND pq.question_no IN ({fmt})", (paper_id,))
                rows = cur.fetchall()
                changed = [(qid, no, t) for qid, no, t in rows if t != "multi_choice"]
                if not changed:
                    continue
                print(f"[{key.split('/')[-1][:34]}] 多选大题题号 {fmt}：" +
                      "、".join(f"{no}({t}->multi_choice)" for _, no, t in changed))
                total += len(changed)
                if args.apply and changed:
                    ids = ",".join(str(qid) for qid, _, _ in changed)
                    cur.execute(f"UPDATE questions SET type='multi_choice' WHERE id IN ({ids})")
        if args.apply:
            conn.commit()
            print(f"\n[ok] 已改 {total} 道题")
        else:
            conn.rollback()
            print(f"\n[dry-run] 将改 {total} 道题；确认后加 --apply")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
