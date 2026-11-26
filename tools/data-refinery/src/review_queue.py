"""人工校对队列：题目身份聚合与 issue 状态收口。

从 ``manual_fix.py`` 搬出（2026-11-26 人工校对重构 Task 3）。分层方向是
``review_queue`` ← ``review_content`` ← ``manual_fix``：本模块只依赖
``review_editor`` 的 ROOT 与 ``scope_filter``，**不得 import manual_fix /
review_content**（否则循环）。

题目身份 = ``(source, group_order, sub_no)``：同一题号的多小问各算一题，
人工确认只收口当前这一小问，别把兄弟小问一起关掉（2026-11-26 重构裁决）。
"""

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from review_editor import ROOT
from scope_filter import match_keyword
from subject_codes import subject_code_for_path

ISSUES_FILE = ROOT / "output" / "recognition_issues.jsonl"
FIXES_DIR = ROOT / "output" / "manual_fixes"


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                    encoding="utf-8")


KIND_TEXT = {
    "missing": "题号缺失",
    "punct_stem": "顿号题号未识别",
    "repair_truncated": "自动修复砍短了内容",
    "junk_question": "卷首页脚被当成题目",
    "incomplete_content": "内容不完整",
    "merged_content": "前后题可能被合并",
    "type_mismatch": "题型与同大题不一致",
    "options_incomplete": "题不完整（选项缺失）",
    "answer_missing": "答案缺失",
    "manual_override": "主动重录",
}

# 内容层问题：先问「你看来有没有问题」，确认没问题就只落结论、不写库
# repair_truncated 也在此列（2026-11-23）：它走自己的「双版本校对」分支，
# 绝不再按「缺失/被吞」直接强制整题重录。
CONTENT_KINDS = ("incomplete_content", "merged_content", "type_mismatch",
                 "options_incomplete", "answer_missing", "repair_truncated")


_REASON_TEXT = {
    "missing_stem": "题号缺失",
    "md_has_no_such_stem": "原 Markdown 里找不到该题号",
    "md_uses_punct_separator": "原 Markdown 用的是顿号题号（如「18、」）",
    "prev_has_two_option_blocks": "上一题里混入了两组选项",
    "prev_has_second_subq_series": "上一题里出现了第二组小问",
    "next_starts_with_subq_no_stem": "下一题以 (1) 开头却没有题干",
    "content_looks_like_page_chrome": "这行是卷首页脚/署名，不是题目",
    "subq_starts_at_2": "小问从 (2) 开始，缺了 (1)",
    "empty_stem": "题干是空的（正文里没有有效文字）",
    "llm_marked_incomplete": "标注时判定题干不完整",
    "flagged_needs_review": "入库时被标为待复核（内容不完整）",
    "answer_empty": "题库里这道题的答案为空",
}


def humanize_reasons(reasons: list[str]) -> list[str]:
    """把扫描器的机器标记翻成人话（认不出的原样保留）。"""
    out: list[str] = []
    for reason in reasons or []:
        if reason in _REASON_TEXT:
            out.append(_REASON_TEXT[reason])
            continue
        m = re.match(r"options_(\d+)of(\d+)", reason)
        if m:
            out.append(f"选项只有 {m.group(1)} 个（应为 {m.group(2)} 个，可能 PDF 转换丢失）")
            continue
        m = re.match(r"prev_len_(\d+)_vs_median_(\d+)", reason)
        if m:
            out.append(f"上一题 {m.group(1)} 字（全卷中位 {m.group(2)} 字）")
            continue
        m = re.match(r"prev_repair_shrank_(\d+)_to_(\d+)", reason)
        if m:
            out.append(f"上一题被自动修复砍短（{m.group(1)}→{m.group(2)} 字）")
            continue
        m = re.match(r"repair_shrank_(\d+)_to_(\d+)", reason)
        if m:
            out.append(f"自动修复把内容砍短（{m.group(1)}→{m.group(2)} 字）")
            continue
        m = re.match(r"md_stem_appears_(\d+)x", reason)
        if m:
            out.append(f"原 Markdown 里该题号出现 {m.group(1)} 次")
            continue
        m = re.match(r"body_contains_stem_(\d+)$", reason)
        if m:
            out.append(f"本题正文里出现了第 {m.group(1)} 题的题号（下一题可能被吞进来了）")
            continue
        m = re.match(r"body_belongs_to_stem_(\d+)$", reason)
        if m:
            out.append(f"这段正文在原 Markdown 里属于第 {m.group(1)} 题（本题可能装错了内容）")
            continue
        m = re.match(r"type_outlier_(\w+?)_(\d+)of(\d+)$", reason)
        if m:
            name = {"choice": "选择题", "short_answer": "简答题",
                    "fill_blank": "填空题", "calculation": "计算题"}.get(m.group(1), m.group(1))
            out.append(f"同一大题 {m.group(3)} 题里有 {m.group(2)} 题是{name}，本题不是"
                       "（选择题丢选项就会这样）")
            continue
        out.append(reason)
    return out


@dataclass
class ReviewItem:
    source: str
    rel_path: str
    group_order: int
    sub_no: int = 0
    flags: list[dict] = field(default_factory=list)
    manual: bool = False

    @property
    def key(self) -> tuple[str, int, int]:
        return self.source, self.group_order, self.sub_no

    @property
    def kinds(self) -> set[str]:
        return {str(f.get("kind") or "") for f in self.flags}

    @property
    def subject(self) -> str:
        """学科 code（chinese / physics …）；路径认不出时回退 generic。"""
        return subject_code_for_path(Path(self.rel_path), default="") or "generic"

    @property
    def is_repair(self) -> bool:
        return "repair_truncated" in self.kinds

    @property
    def dominant_type(self) -> str | None:
        return next(
            (f.get("dominant_type") for f in self.flags if f.get("dominant_type")),
            None,
        )

    def note(self) -> str:
        if "type_mismatch" in self.kinds:
            return "题型与同大题不一致，请录入完整题目和选项"
        if "merged_content" in self.kinds:
            return "正文混入了别题内容，请只保留本题内容"
        if "options_incomplete" in self.kinds:
            return "选项不全，请录入完整题目和选项"
        if "answer_missing" in self.kinds:
            return "答案缺失，请补答案"
        if "missing" in self.kinds or "punct_stem" in self.kinds:
            return "题目缺失或被吞，请按原卷补录"
        return "请按原卷校对本题"

    def targets(self) -> list["ReviewTarget"]:
        seq: list[ReviewTarget] = []
        if "missing" in self.kinds:
            flag = next(
                (f for f in self.flags if f.get("suspect_group_order")),
                None,
            )
            # 旧实现（manual_fix._targets）有 isinstance 守卫：issues.jsonl 可能被手改，
            # suspect 是字符串时不能 int() 硬转，更不能让整轮校对崩掉 —— 退化成本题目标。
            raw = flag.get("suspect_group_order") if flag else None
            if isinstance(raw, int):
                try:
                    suspect_sub = int(flag.get("suspect_sub_no") or 0)
                except (TypeError, ValueError):
                    suspect_sub = 0
                if (raw, suspect_sub) != (self.group_order, self.sub_no):
                    seq.append(
                        ReviewTarget(
                            raw,
                            suspect_sub,
                            "这一题的正文里混进了下一题，请只保留本题自己的内容",
                        )
                    )
        seq.append(
            ReviewTarget(
                self.group_order,
                self.sub_no,
                self.note(),
            )
        )
        return seq


@dataclass
class ReviewTarget:
    group_order: int
    sub_no: int = 0
    note: str = ""


def group_items(issues: list[dict]) -> list[ReviewItem]:
    order: dict[tuple[str, int, int], ReviewItem] = {}
    for rec in issues:
        if rec.get("status") != "pending":
            continue
        key = (
            rec["source"],
            int(rec.get("group_order") or 0),
            int(rec.get("sub_no") or 0),
        )
        item = order.get(key)
        if item is None:
            item = order[key] = ReviewItem(
                source=key[0],
                rel_path=rec.get("rel_path") or "",
                group_order=key[1],
                sub_no=key[2],
            )
        item.flags.append(rec)
    return sorted(order.values(), key=lambda i: i.key)


def pending_issues(sources: set[str] | None = None,
                   file: str | None = None) -> list[dict]:
    """取待处理的识别问题；sources 精确限定卷（import_cli 用），file 是卷名关键词。"""
    issues = [i for i in _read_jsonl(ISSUES_FILE) if i.get("status") == "pending"]
    if sources is not None:
        issues = [i for i in issues if i["source"] in sources]
    if file:
        issues = [i for i in issues if match_keyword(i["source"], file)]
    return issues


def pending_items(sources: set[str] | None = None,
                  file: str | None = None) -> list[ReviewItem]:
    """待处理队列按题目身份聚合（同题多小问分开）。"""
    return group_items(pending_issues(sources, file))


def mark_issue(source: str, group_order: int, status: str, *,
               sub_no: int | None = None, statuses: set[str] | tuple[str, ...] | None = None,
               note: str | None = None, fix_file: str | None = None,
               kind: str | None = None, **extra) -> int:
    """把某卷**某题**的识别问题切到指定状态；返回改动条数。

    2026-11-23 起不再按 kind 过滤（`kind` 参数仅为兼容旧调用保留、已忽略）：
    人工对同一道题答一次「没问题」或一次成功写库，就必须关掉该题**全部** flag，
    否则同一道题会换个 kind 再问一遍（西城模拟一题18 实测）。

    可选收口范围（2026-11-26）：`sub_no` 只动该小问；`statuses` 只动这些状态
    （如只把 pending 记成 recorded，不把已 resolved 的降级）。

    状态语义（2026-10-31 修订）：
    - pending  ：待人工补录
    - recorded ：已补录，但还没写进库（等 apply_fixes_cli --apply）
    - resolved ：已写进库；`verdict=no_change` 是「人工确认无问题、未改动」的收口
    """
    rows = _read_jsonl(ISSUES_FILE)
    changed = 0
    for rec in rows:
        if rec.get("source") != source or int(rec.get("group_order", -1)) != int(group_order):
            continue
        if sub_no is not None and int(rec.get("sub_no") or 0) != int(sub_no):
            continue
        if statuses is not None and rec.get("status") not in statuses:
            continue

        if rec.get("status") == status and note is None:
            continue
        rec["status"] = status
        if status == "resolved":
            rec["resolved_at"] = datetime.now().isoformat(timespec="seconds")
        else:
            rec.pop("resolved_at", None)
        if fix_file:
            rec["fix_file"] = fix_file
        if note is not None:
            rec["note"] = note
        for key, value in extra.items():
            if value is None:
                continue
            rec[key] = value
        changed += 1
    if changed:
        _write_jsonl(ISSUES_FILE, rows)
    return changed


def recorded_flags(item: ReviewItem, fix_file: str, recorded_at: str) -> int:
    """补题落盘后只把该小问的 pending flag 标成 recorded（不碰已 resolved 的）。"""
    return mark_issue(item.source, item.group_order, "recorded",
                      sub_no=item.sub_no, statuses={"pending"},
                      note=None, fix_file=fix_file, recorded_at=recorded_at)
