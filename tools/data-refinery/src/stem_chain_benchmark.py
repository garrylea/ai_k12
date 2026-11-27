import argparse
import json
from pathlib import Path

from question_extract import _load_prepared_text
from stem_chain import (
    collect_interval_candidates, collect_main_stem_probes,
    select_stem_anchors, select_stem_chains,
)
from subject_strategies import get_strategy


def _ratio(hit: int, total: int) -> float:
    return 0.0 if total == 0 else hit / total


def evaluate_source(golden: dict, result, anchors=()) -> dict:
    expected_numbers = set(golden["question_numbers"])
    actual_numbers = {
        number for number, _form, _recovery in result.accepted.values()
    } | {anchor.options[0].number for anchor in anchors}
    expected_boundaries = {int(k): int(v) for k, v in golden["boundaries"].items()}
    actual_boundaries = {
        line: number for line, (number, _form, _recovery) in result.accepted.items()
    }
    actual_boundaries.update({
        anchor.line_no: anchor.options[0].number for anchor in anchors
    })
    return {
        "source": golden["source"],
        "numbers_exact": actual_numbers == expected_numbers,
        "number_precision": _ratio(len(actual_numbers & expected_numbers), len(actual_numbers)),
        "number_recall": _ratio(len(actual_numbers & expected_numbers), len(expected_numbers)),
        "boundary_precision": _ratio(
            len(set(actual_boundaries.items()) & set(expected_boundaries.items())),
            len(actual_boundaries),
        ),
        "boundary_recall": _ratio(
            len(set(actual_boundaries.items()) & set(expected_boundaries.items())),
            len(expected_boundaries),
        ),
        "gap_count": len(result.gaps),
        "ambiguous_count": len(result.ambiguities),
        "llm_calls": len(result.ambiguities),
    }


def summarize(rows: list[dict]) -> dict:
    count = len(rows)
    return {
        "sources": count,
        "exact_number_rate": _ratio(sum(r.get("numbers_exact", False) for r in rows), count),
        "mean_number_precision": _ratio(sum(r.get("number_precision", 0.0) for r in rows), count),
        "mean_number_recall": _ratio(sum(r.get("number_recall", 0.0) for r in rows), count),
        "mean_boundary_precision": _ratio(sum(r.get("boundary_precision", 0.0) for r in rows), count),
        "mean_boundary_recall": _ratio(sum(r.get("boundary_recall", 0.0) for r in rows), count),
        "llm_call_rate": _ratio(sum(r.get("llm_calls", 0) > 0 for r in rows), count),
        "gap_source_rate": _ratio(sum(r.get("gap_count", 0) > 0 for r in rows), count),
    }


def run_golden(golden_rows: list[dict], md_root: Path) -> list[dict]:
    strategy = get_strategy("math")
    rows: list[dict] = []
    for golden in golden_rows:
        matches = sorted(md_root.rglob(f"{golden['source']}.md"))
        if len(matches) != 1:
            raise RuntimeError(
                f"golden source must resolve to one md: {golden['source']} -> {len(matches)}"
            )
        md_path = matches[0]
        text = _load_prepared_text(md_path)
        probes = collect_main_stem_probes(text, strategy)
        anchors = select_stem_anchors(probes)
        collection = collect_interval_candidates(text, strategy, anchors)
        result = select_stem_chains(
            collection, source_lines=text.split("\n"),
        )
        rows.append(evaluate_source(golden, result, anchors=collection.anchors))
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--golden", required=True)
    parser.add_argument("--md-root", default="output/md")
    parser.add_argument("--json-out", required=True)
    args = parser.parse_args(argv)
    golden_rows = [
        json.loads(line)
        for line in Path(args.golden).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    rows = run_golden(golden_rows, Path(args.md_root))
    payload = {
        "golden_sources": len(golden_rows),
        "summary": summarize(rows),
        "per_source": rows,
    }
    Path(args.json_out).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
