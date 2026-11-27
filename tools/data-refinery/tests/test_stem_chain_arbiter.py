import json
from types import SimpleNamespace

from stem_chain import (
    StemAmbiguity, StemCandidate, StemEvidence, StemOption, StemPath,
)
from stem_chain_arbiter import arbitrate_stem_ambiguities, validate_arbiter_payload


def _option(number: int, cid: str) -> StemOption:
    return StemOption(
        candidate_id=cid,
        raw_number=number,
        number=number,
        form="glued_number",
        recovery="glued_suffix",
        evidence=(StemEvidence("blank_before", "positive"),),
        content_rest=f"{number}. 正文",
    )


def _ambiguity() -> StemAmbiguity:
    left = _option(12, "left")
    right = _option(12, "right")
    candidates = (
        StemCandidate(1, "12.8 米", (left,), "", ""),
        StemCandidate(2, "12.16 世纪", (right,), "", ""),
    )
    return StemAmbiguity(
        reason="ambiguous",
        left_anchor=11,
        right_anchor=13,
        expected_numbers=(12,),
        candidates=candidates,
        top_paths=(
            StemPath(((1, 12, "left"),), (1, -1, -1, 0), (left,)),
            StemPath(((2, 12, "right"),), (1, -1, -1, 0), (right,)),
        ),
    )


def test_arbiter_payload_accepts_one_closed_candidate_per_number():
    payload = {"intervals": [{
        "interval_id": "C11-13",
        "result": "resolved",
        "assignments": [{"number": 12, "candidate_id": "right"}],
    }]}
    result = validate_arbiter_payload(payload, [_ambiguity()])
    assert result.accepted[2] == (12, "glued_number", "glued_suffix")
    assert [issue.code for issue in result.issues] == ["stem_chain_llm_resolved"]


def test_arbiter_rejects_candidate_outside_interval():
    payload = {"intervals": [{
        "interval_id": "C11-13",
        "result": "resolved",
        "assignments": [{"number": 12, "candidate_id": "DOES-NOT-EXIST"}],
    }]}
    result = validate_arbiter_payload(payload, [_ambiguity()])
    assert result.accepted == {}
    assert result.issues[0].code == "stem_chain_llm_invalid"


def test_arbiter_unavailable_is_unresolved_not_remote_fallback():
    class BrokenLLM:
        def complete(self, system, user):
            raise RuntimeError("local offline")

    result = arbitrate_stem_ambiguities(BrokenLLM(), [_ambiguity()], "卷A")
    assert result.accepted == {}
    assert result.issues[0].code == "stem_chain_llm_unresolved"


def test_arbiter_sends_one_batch_for_multiple_intervals():
    class RecordingLLM:
        def __init__(self):
            self.user = ""

        def complete(self, system, user):
            self.user = user
            return SimpleNamespace(content=json.dumps({"intervals": []}))

    llm = RecordingLLM()
    arbitrate_stem_ambiguities(llm, [_ambiguity(), _ambiguity()], "卷A")
    assert llm.user.count('"interval_id": "C11-13"') == 2
