from stem_chain import StemChainResult
from stem_chain_benchmark import evaluate_source, summarize


def _result(lines: dict[int, int], issues: list | None = None) -> StemChainResult:
    return StemChainResult(
        accepted={line: (number, "main", "exact") for line, number in lines.items()},
        gaps=[],
        gap_segments=[],
        ambiguities=[],
        safe_prefix={},
        issues=issues or [],
    )


def test_evaluate_source_reports_number_and_boundary_accuracy():
    golden = {
        "source": "卷A",
        "question_numbers": [1, 2, 3],
        "boundaries": {0: 1, 2: 2, 4: 3},
    }
    result = _result({0: 1, 2: 2, 4: 4})
    metrics = evaluate_source(golden, result)
    assert metrics["numbers_exact"] is False
    assert metrics["number_precision"] == 2 / 3
    assert metrics["number_recall"] == 2 / 3
    assert metrics["boundary_precision"] == 2 / 3
    assert metrics["boundary_recall"] == 2 / 3


def test_summarize_counts_llm_and_gap_rates():
    rows = [
        {"llm_calls": 0, "gap_count": 0, "ambiguous_count": 0},
        {"llm_calls": 1, "gap_count": 1, "ambiguous_count": 1},
    ]
    summary = summarize(rows)
    assert summary["sources"] == 2
    assert summary["llm_call_rate"] == 0.5
    assert summary["gap_source_rate"] == 0.5
