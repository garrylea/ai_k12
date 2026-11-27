import json
from dataclasses import dataclass
from pathlib import Path

from extract import _parse_json_object
from stem_chain import StemAmbiguity, StemIssue


@dataclass(frozen=True)
class StemArbitrationResult:
    accepted: dict[int, tuple[int, str, str]]
    issues: list[StemIssue]


def _interval_id(ambiguity: StemAmbiguity) -> str:
    return f"C{ambiguity.left_anchor}-{ambiguity.right_anchor}"


def _request_payload(ambiguities: list[StemAmbiguity]) -> dict:
    intervals = []
    for ambiguity in ambiguities:
        intervals.append({
            "interval_id": _interval_id(ambiguity),
            "left_anchor": ambiguity.left_anchor,
            "right_anchor": ambiguity.right_anchor,
            "expected_numbers": list(ambiguity.expected_numbers),
            "candidates": [
                {
                    "candidate_id": option.candidate_id,
                    "line_no": candidate.line_no,
                    "raw_number": option.raw_number,
                    "number": option.number,
                    "form": option.form,
                    "recovery": option.recovery,
                    "evidence": [e.tag for e in option.evidence],
                    "content": option.content_rest,
                    "before": candidate.context_before,
                    "after": candidate.context_after,
                }
                for candidate in ambiguity.candidates
                for option in candidate.options
            ],
        })
    return {"intervals": intervals}


def validate_arbiter_payload(
    payload: dict, ambiguities: list[StemAmbiguity],
) -> StemArbitrationResult:
    by_interval = {_interval_id(a): a for a in ambiguities}
    accepted: dict[int, tuple[int, str, str]] = {}
    issues: list[StemIssue] = []
    for item in payload.get("intervals", []):
        interval_id = item.get("interval_id")
        ambiguity = by_interval.get(interval_id)
        if ambiguity is None:
            continue
        if item.get("result") != "resolved":
            first_line = min(
                (candidate.line_no for candidate in ambiguity.candidates),
                default=0,
            )
            issues.append(StemIssue(
                code="stem_chain_llm_unresolved",
                severity="warning",
                message=f"{interval_id} 本地 LLM 未能唯一分配",
                line_no=first_line + 1,
                excerpt="",
                question_no=ambiguity.expected_numbers[0],
                interval_id=interval_id,
            ))
            continue
        options = {
            option.candidate_id: (candidate.line_no, option)
            for candidate in ambiguity.candidates
            for option in candidate.options
        }
        seen_ids: set[str] = set()
        seen_numbers: set[int] = set()
        rows: list[tuple[int, int, str, str]] = []
        valid = True
        for assignment in item.get("assignments", []):
            try:
                number = int(assignment["number"])
                cid = str(assignment["candidate_id"])
            except (KeyError, TypeError, ValueError):
                valid = False
                break
            if number not in ambiguity.expected_numbers or cid not in options:
                valid = False
                break
            if cid in seen_ids or number in seen_numbers:
                valid = False
                break
            line_no, option = options[cid]
            seen_ids.add(cid)
            seen_numbers.add(number)
            rows.append((line_no, number, option.form, option.recovery))
        if valid:
            rows.sort()
            valid = (
                seen_numbers == set(ambiguity.expected_numbers)
                and all(rows[i][0] < rows[i + 1][0] for i in range(len(rows) - 1))
            )
        if not valid:
            first_line = min(
                (candidate.line_no for candidate in ambiguity.candidates),
                default=0,
            )
            issues.append(StemIssue(
                code="stem_chain_llm_invalid",
                severity="warning",
                message=f"{interval_id} 返回越界、重复、漏填或乱序分配",
                line_no=first_line + 1,
                excerpt=json.dumps(item, ensure_ascii=False)[:600],
                question_no=ambiguity.expected_numbers[0],
                interval_id=interval_id,
            ))
            continue
        for line_no, number, form, recovery in rows:
            accepted[line_no] = (number, form, recovery)
        issues.append(StemIssue(
            code="stem_chain_llm_resolved",
            severity="info",
            message=f"{interval_id} 本地 LLM 完成闭集分配",
            line_no=rows[0][0] + 1,
            excerpt="",
            question_no=rows[0][1],
            interval_id=interval_id,
        ))
    return StemArbitrationResult(accepted=accepted, issues=issues)


def arbitrate_stem_ambiguities(
    llm, ambiguities: list[StemAmbiguity], paper_stem: str = "",
) -> StemArbitrationResult:
    if not ambiguities:
        return StemArbitrationResult({}, [])
    try:
        system = (Path(__file__).parent / "prompts" / "stem_chain_arbiter.txt").read_text(
            encoding="utf-8"
        )
        user = json.dumps(_request_payload(ambiguities), ensure_ascii=False, indent=2)
        response = llm.complete(system, user)
        payload = _parse_json_object(response.content or "")
        return validate_arbiter_payload(payload, ambiguities)
    except Exception as exc:
        return StemArbitrationResult({}, [
            StemIssue(
                code="stem_chain_llm_unresolved",
                severity="warning",
                message=f"{paper_stem}: 本地 LLM 仲裁不可用：{exc}",
                line_no=1,
                excerpt="",
            )
        ])
