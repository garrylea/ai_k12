"""publish 子命令：物化图片 + 改写路径，输出 published JSONL。

读 ``output/extracted/`` 下的 ``<stem>.jsonl``，把每条记录里的原始 mineru 图片引用
``![alt](images/xxx.jpg)`` 按 §9 规范名物化到 ``output/assets/``，改写为规范相对路径，
填充 ``content_metadata.images[]`` / ``options[].image_url``，输出到 ``output/published/``。

**暂不入库 MySQL**：资源路径用源相对稳定键（``questions/{subject}/{hash}/{idx}``、
``textbooks/{subject}/{hash}/{sort_order}``），DB 入库与 lesson_id 映射后置
（见 publish 计划 §5.2 方案 2、§8 #1）。
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

SUBJECT_CODE = "math"  # MVP 仅数学


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="物化图片 + 改写路径，输出 published JSONL")
    parser.add_argument("--input-dir", help="extract 产物目录（默认 output/extracted）")
    parser.add_argument("--output-dir", help="published 输出目录（默认 output/published）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
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
        key = str(rel_file)
        if not args.force and not args.reconvert and checkpoint.is_published(key):
            skipped += 1
            continue
        try:
            kind = _kind_for(rel_file)
            md_images_dir = md_dir / rel_file.parent  # 含 images/ 的目录
            source_key = _hash8(key)

            raw_items = [
                json.loads(line)
                for line in jsonl_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]

            out_items = []
            for idx, raw in enumerate(raw_items, start=1):
                if kind == "questions":
                    item = ExamQuestion(**raw)
                    asset_prefix = f"questions/{SUBJECT_CODE}/{source_key}/{idx}"
                else:
                    item = TextbookCard(**raw)
                    asset_prefix = f"textbooks/{SUBJECT_CODE}/{source_key}/{item.sort_order}"
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
