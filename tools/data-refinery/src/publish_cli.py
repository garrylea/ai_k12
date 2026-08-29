"""publish 子命令：物化图片 + 改写路径，输出 published JSONL。

读 ``output/extracted/`` 下的 ``<stem>.jsonl``，把每条记录里的原始 mineru 图片引用
``![alt](images/xxx.jpg)`` 按 §9 规范名物化到 ``output/assets/``，改写为规范相对路径，
填充 ``content_metadata.images[]`` / ``options[].image_url``，输出到 ``output/published/``。

资产路径用源相对稳定键（``questions/{subject}/{hash}/{idx}``、
``textbooks/{subject}/{hash}/{sort_order}``）。subject 按文件相对路径首段
（中文学科名，如 ``数学/``）推导；识别不了的学科回退 ``math``（MVP 兼容旧行为）。
"""

import argparse
import hashlib
import json
from pathlib import Path

from asset_store import LocalAssetStore
from checkpoint import RefineryCheckpoint
from config import RefineryConfig
from image_rewrite import rewrite_item
from models import ExamQuestion, TextbookCard

# 中文学科名 -> subject code（与 db_loader._subject_code_by_name_fallback 一致）
_SUBJECT_NAME_TO_CODE = {
    "数学": "math", "语文": "chinese", "英语": "english",
    "物理": "physics", "化学": "chemistry", "生物": "biology",
    "历史": "history", "地理": "geography", "道德与法治": "politics",
}
_DEFAULT_SUBJECT_CODE = "math"  # 识别不出学科时回退（兼容旧资产路径）


def _subject_code_for(rel_file: Path) -> str:
    """从文件相对路径首段（中文学科名）推导 subject code。

    rel 形如 ``数学/初中/.../page_001`` 或 ``化学/初中/second/2024/xxx-试卷``，
    首段即学科。修复前 SUBJECT_CODE 硬编码 "math"，化学等学科资产路径被误标。
    """
    parts = rel_file.parts
    if parts:
        return _SUBJECT_NAME_TO_CODE.get(parts[0], _DEFAULT_SUBJECT_CODE)
    return _DEFAULT_SUBJECT_CODE


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="物化图片 + 改写路径，输出 published JSONL")
    parser.add_argument("--input-dir", help="extract 产物目录（默认 output/extracted）")
    parser.add_argument("--output-dir", help="published 输出目录（默认 output/published）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
    parser.add_argument("--book", help="只发布匹配的教材/试卷（rel_path 子串匹配，如'九年级/上册'）")
    parser.add_argument("--pages", help="页码过滤，如 '1-6' 或 '1,3,5-8'")
    parser.add_argument("--force", action="store_true", help="强制重新发布（忽略 checkpoint，但不删除已有输出）")
    parser.add_argument("--reconvert", action="store_true", help="清除 checkpoint + 删除已有 published 文件，重新发布")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要发布的 JSONL")
    return parser.parse_args(argv)


def _match_source(rel_file: Path, filter_value: str) -> bool:
    name = rel_file.name
    if filter_value == "all":
        return True
    if filter_value == "zgkao":
        return "试卷" in name or "答案" in name
    if filter_value == "smartedu":
        return "试卷" not in name and "答案" not in name
    return False


def _parse_pages(pages_spec: str) -> set[int]:
    """Parse page spec like '1-6' or '1,3,5-8' into a set of page numbers."""
    result: set[int] = set()
    for part in pages_spec.split(","):
        part = part.strip()
        if "-" in part:
            lo, hi = part.split("-", 1)
            result.update(range(int(lo.strip()), int(hi.strip()) + 1))
        else:
            result.add(int(part))
    return result


def _match_pages(jsonl_name: str, page_nums: set[int]) -> bool:
    """Check if page_XXX.jsonl matches any of the given page numbers.

    非 page_*.jsonl（试卷/答案聚合文件）不参与页过滤，视为匹配。
    """
    import re
    m = re.search(r"page_(\d+)", jsonl_name)
    if m:
        return int(m.group(1)) in page_nums
    return True


def _kind_for(rel_file: Path) -> str:
    name = rel_file.name
    if "试卷" in name or "答案" in name:
        return "questions"
    return "cards"


def _hash8(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()[:8]


def main(argv=None):
    args = parse_args(argv)
    config = RefineryConfig.from_env(input_dir=None, output_dir=None)
    extracted_dir = Path(args.input_dir) if args.input_dir else config.output_dir / "extracted"
    published_dir = Path(args.output_dir) if args.output_dir else config.output_dir / "published"
    md_dir = config.output_dir / "md"
    assets_dir = config.output_dir / "assets"

    store = LocalAssetStore(assets_dir)
    checkpoint = RefineryCheckpoint(config.output_dir / ".publish_checkpoint.json")
    checkpoint.load()

    jsonl_files = sorted(extracted_dir.rglob("*.jsonl"))

    # --pages：页码过滤（page_*.jsonl 按页号匹配；试卷/答案聚合文件不受影响）
    page_nums = _parse_pages(args.pages) if args.pages else None
    if page_nums is not None:
        jsonl_files = [p for p in jsonl_files if _match_pages(p.name, page_nums)]

    if args.dry_run:
        for p in jsonl_files:
            rel = p.relative_to(extracted_dir).with_suffix("")
            if _match_source(rel, args.source):
                print(f"[dry-run] {rel}.jsonl ({_kind_for(rel)})")
        return

    # --reconvert：清理匹配文件的 checkpoint + 删除已有 published 文件
    if args.reconvert:
        cleared = 0
        for jsonl_path in jsonl_files:
            rel = jsonl_path.relative_to(extracted_dir)
            rel_file = rel.with_suffix("")
            if not _match_source(rel_file, args.source):
                continue
            if args.book and args.book not in str(rel_file):
                continue
            key = str(rel_file)
            if checkpoint.is_published(key):
                checkpoint.unmark_published(key)
            out_file = published_dir / rel
            if out_file.exists():
                out_file.unlink()
                print(f"[reconvert] deleted {out_file}", flush=True)
            cleared += 1
        print(f"[reconvert] cleared checkpoint for {cleared} source(s)", flush=True)

    published = 0
    skipped = 0
    failed = 0

    for jsonl_path in jsonl_files:
        rel = jsonl_path.relative_to(extracted_dir)  # e.g. 数学/.../试卷/试卷.jsonl
        rel_file = rel.with_suffix("")  # 去掉 .jsonl
        if not _match_source(rel_file, args.source):
            continue
        if args.book and args.book not in str(rel_file):
            continue
        key = str(rel_file)
        if not args.force and not args.reconvert and checkpoint.is_published(key):
            skipped += 1
            continue
        try:
            kind = _kind_for(rel_file)
            md_images_dir = md_dir / rel_file.parent  # 含 images/ 的目录
            source_key = _hash8(key)
            subject_code = _subject_code_for(rel_file)

            raw_items = [
                json.loads(line)
                for line in jsonl_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]

            out_items = []
            for idx, raw in enumerate(raw_items, start=1):
                if kind == "questions":
                    item = ExamQuestion(**raw)
                    asset_prefix = f"questions/{subject_code}/{source_key}/{idx}"
                else:
                    item = TextbookCard(**raw)
                    asset_prefix = f"textbooks/{subject_code}/{source_key}/{item.sort_order}"
                rewrite_item(item, kind, md_images_dir, store, asset_prefix)
                out_items.append(item.model_dump(mode="json"))

            out_file = published_dir / rel
            out_file.parent.mkdir(parents=True, exist_ok=True)
            with out_file.open("w", encoding="utf-8") as f:
                for item in out_items:
                    f.write(json.dumps(item, ensure_ascii=False) + "\n")

            checkpoint.mark_published(key)
            published += 1
        except Exception as e:
            print(f"[ERROR] {key}: {e}")
            failed += 1

    print(f"Published: {published}, Skipped: {skipped}, Failed: {failed}")


if __name__ == "__main__":
    main()
