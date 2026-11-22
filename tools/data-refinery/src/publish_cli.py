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
from chinese_material_doc import externalize_chinese_materials, same_article
from config import RefineryConfig
from image_rewrite import rewrite_item
from material_kind import SCOPE_KIND, kind_of_jsonl
from models import ExamQuestion, TextbookCard
from page_markers import strip_page_markers
from scope_filter import build_scope, describe, match_keyword, match_scope
from subject_codes import subject_code_for_path as _subject_code_for

# 发布口径版本：改写范围/规则变化时 +1。旧版本的产物会被**自动重发**，
# 不需要用户记住 `--force`（2026-10-31 用户指出：能记一个命令就不该让人记两个）。
# 2 = 起于 2026-10-31：answer 字段里的图片也一并物化改写。
# 3 = 起于 2026-11-20：语文共享文章外置为 materials/chinese/{doc_key}/content.md。
# 注意：2026-11-22 给 doc_key 加了卷维度，但**故意不 bump 版本** —— bump 会强制
# 所有旧卷重发、把全库文档换成新 key，等同一次全量迁移；本需求是「只对新导入生效」。
PUBLISH_VERSION = 3

# 试卷题干/材料/答案/解析里可能残留的页码标记（extract 已洗，这里兜底）
_QUESTION_TEXT_FIELDS = ("content", "material_text", "answer", "explanation")


def _strip_page_markers_from_question(item: ExamQuestion, rel: Path) -> None:
    """清洗单题文本字段里的页码标记。

    extract 阶段已经洗过；这里再洗一遍是为了让 **published JSONL 本身干净** ——
    db_loader 以 published 为准，旧产物若带页脚，重跑入库会把页脚写回库。
    """
    removed_total = 0
    for name in _QUESTION_TEXT_FIELDS:
        value = getattr(item, name, None)
        if not value:
            continue
        cleaned, hits = strip_page_markers(value)
        removed = [h for h in hits if h.removed]
        manual = [h for h in hits if not h.removed]
        if removed and cleaned != value:
            setattr(item, name, cleaned)
            removed_total += len(removed)
        if manual:
            print(f"[WARN] [page-marker] {rel}: {name} 未处理 {len(manual)} 处"
                  f"（表格/标签/围栏内）", flush=True)
    if removed_total:
        print(f"[page-marker] {rel}: 删除 {removed_total} 处页码/页眉标记", flush=True)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="物化图片 + 改写路径，输出 published JSONL")
    parser.add_argument("--input-dir", help="extract 产物目录（默认 output/extracted）")
    parser.add_argument("--output-dir", help="published 输出目录（默认 output/published）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
    parser.add_argument("--book", help="只发布命中的教材/试卷（空格等分隔符分词，所有词都命中 rel_path，如 '九年级 上册'）")
    parser.add_argument("--pages", help="页码过滤，如 '1-6' 或 '1,3,5-8'")
    parser.add_argument("--subject", help="学科过滤（中文名或 code，如 语文 / chinese），逗号分隔多个")
    parser.add_argument("--stage", help="学段过滤（初中/小学/高中 或 junior/primary/senior），逗号分隔多个")
    parser.add_argument("--term", help="学期过滤（上/下 或 first/second；教材也可写 上册/下册），逗号分隔多个")
    parser.add_argument("--year", help="年份过滤（4 位，仅试卷素材，如 2025），逗号分隔多个")
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


def _record_target(rec: dict) -> str | None:
    """补题记录的材料目标：material_target 优先，回退旧 material_scope。"""
    t = rec.get("material_target")
    if t in ("article", "inline", "both"):
        return t
    s = rec.get("material_scope")
    if s == "article":
        return "article"
    if s in ("inline", "legacy_inline"):
        return "inline"
    return None


def _manual_inline_materials(output_dir: Path, sources: set[str], *,
                             rel_path: str | None = None) -> dict[str, dict[int, str]]:
    """人工校对的**题内素材**修正：publish 时回写，优先于自动找回的 _post_material_text。

    --redo 的 extract 会重写 extracted JSONL，只写在那里会被冲掉；补题记录是持久源。
    只回注 ``inline``（material_text）/``both``（material_inline_text）两类；``article``
    修正只经 material_doc_overrides.jsonl 落到文档，**绝不写进 material_text**。
    ``rel_path`` 用于避免不同目录下的同名卷互相串。
    """
    fixes_dir = Path(output_dir) / "manual_fixes"
    out: dict[str, dict[int, str]] = {}
    for src in sources:
        path = fixes_dir / f"{src}.jsonl"
        if not path.exists():
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not rec.get("applied") or rec.get("answer_only"):
                continue
            if rel_path and rec.get("rel_path") and rec["rel_path"] != rel_path:
                continue
            target = _record_target(rec)
            if target == "inline":
                text = rec.get("material_text")
            elif target == "both":
                text = rec.get("material_inline_text")
            else:
                continue
            if (text or "").strip():
                try:
                    out.setdefault(src, {})[int(rec["group_order"])] = text
                except (TypeError, ValueError):
                    continue
    return out


def _kind_for(jsonl_path: Path) -> str:
    """按 JSONL 里记录的**形状**判类型，形状判不出再退回文件名。

    文件名会把「手工丢进来、名字不带试卷二字」的卷子判成教材卡，进而用
    TextbookCard 去解析试卷题（2026-11-03 北京中学卷实测）。数据已经切好了，
    形状比文件名可信。
    """
    kind = kind_of_jsonl(jsonl_path)
    if kind is not None:
        return SCOPE_KIND[kind]
    return "questions" if ("试卷" in jsonl_path.name or "答案" in jsonl_path.name) else "cards"


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

    # 统一范围过滤（学科/学段/学期/年份），与 extract/db_loader 同语义
    scope = build_scope(subject=args.subject, stage=args.stage, term=args.term, year=args.year)
    if scope.active:
        jsonl_files = [
            p for p in jsonl_files
            if match_scope(p.relative_to(extracted_dir).with_suffix(""), scope)
        ]
        print(f"[scope] {describe(scope)} -> {len(jsonl_files)} 个文件", flush=True)

    if args.dry_run:
        for p in jsonl_files:
            rel = p.relative_to(extracted_dir).with_suffix("")
            if not _match_source(rel, args.source):
                continue
            # --book 与正式发布同口径（否则预演范围偏大，误导重发布判断）
            if args.book and not match_keyword(rel, args.book):
                continue
            print(f"[dry-run] {rel}.jsonl ({_kind_for(p)})")
        return

    # --reconvert：清理匹配文件的 checkpoint + 删除已有 published 文件
    if args.reconvert:
        cleared = 0
        for jsonl_path in jsonl_files:
            rel = jsonl_path.relative_to(extracted_dir)
            rel_file = rel.with_suffix("")
            if not _match_source(rel_file, args.source):
                continue
            if args.book and not match_keyword(rel_file, args.book):
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
        if args.book and not match_keyword(rel_file, args.book):
            continue
        key = str(rel_file)
        src_hash = hashlib.sha256(jsonl_path.read_bytes()).hexdigest()
        if (not args.force and not args.reconvert
                and checkpoint.publish_version_of(key) == PUBLISH_VERSION
                and checkpoint.publish_source_of(key) == src_hash):
            skipped += 1
            continue
        try:
            kind = _kind_for(jsonl_path)
            md_images_dir = md_dir / rel_file.parent  # 含 images/ 的目录
            source_key = _hash8(key)
            subject_code = _subject_code_for(rel_file)

            raw_items = [
                json.loads(line)
                for line in jsonl_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]

            if kind == "questions":
                # 题后找回材料先摘出来，避免被当成文章一起外置；
                # 文章外置完再写回 material_text（题内素材，不占 material_url）。
                post_materials = {
                    idx: raw.pop("_post_material_text")
                    for idx, raw in enumerate(raw_items)
                    if raw.get("_post_material_text")
                }
                items = [ExamQuestion(**raw) for raw in raw_items]
                if subject_code == "chinese":
                    paper_scope = rel_file.as_posix()
                    externalize_chinese_materials(
                        items,
                        md_images_dir=md_images_dir,
                        assets_dir=assets_dir,
                        store=store,
                        subject_code=subject_code,
                        paper_scope=paper_scope,
                    )

                    doc_cache: dict[str | None, str | None] = {}

                    def _doc_body(url):
                        if url not in doc_cache:
                            p = (Path(assets_dir) / url) if url else None
                            try:
                                doc_cache[url] = (p.read_text(encoding="utf-8")
                                                  if p and p.exists() else None)
                            except OSError:
                                doc_cache[url] = None
                        return doc_cache[url]

                    # 同卷所有已外置的文章正文：题内素材判重要跟整卷的文章比，
                    # 不能只看本题的 material_url —— URL 分叉/为空时那段判重会失效，
                    # 整篇文章就会被当题内素材注回去（2026-11-22 Q21 实测）。
                    article_bodies = [b for b in (
                        _doc_body(it.material_url) for it in items) if b]

                    def _inject(item, text, method):
                        """写题内素材；若与同卷任一篇文章是同段（Q5 类重复）则丢弃并记账。"""
                        if not (text or "").strip():
                            return
                        if any(same_article(text, body) for body in article_bodies):
                            heal_path = config.output_dir / "material_duplicate_healed.jsonl"
                            heal_path.parent.mkdir(parents=True, exist_ok=True)
                            with heal_path.open("a", encoding="utf-8") as f:
                                f.write(json.dumps({
                                    "source": item.source,
                                    "group_order": item.group_order,
                                    "chars": len(text),
                                    "reason": "duplicate_of_doc",
                                }, ensure_ascii=False) + "\n")
                            return
                        item.material_text = text
                        item.material_method = method

                    for idx, text in post_materials.items():
                        _inject(items[idx], text, "rule")
                    # 人工 inline 修正优先于自动找回：--redo 冲掉 extracted 后仍保得住
                    manual_inline = _manual_inline_materials(
                        config.output_dir, {it.source for it in items},
                        rel_path=rel_file.parent.as_posix())
                    for item in items:
                        override = manual_inline.get(item.source, {}).get(item.group_order)
                        if override:
                            _inject(item, override, "manual")
                out_items = []
                for idx, item in enumerate(items, start=1):
                    asset_prefix = f"questions/{subject_code}/{source_key}/{idx}"
                    _strip_page_markers_from_question(item, rel)
                    rewrite_item(item, kind, md_images_dir, store, asset_prefix)
                    out_items.append(item.model_dump(mode="json"))
            else:
                out_items = []
                for idx, raw in enumerate(raw_items, start=1):
                    item = TextbookCard(**raw)
                    asset_prefix = f"textbooks/{subject_code}/{source_key}/{item.sort_order}"
                    rewrite_item(item, kind, md_images_dir, store, asset_prefix)
                    out_items.append(item.model_dump(mode="json"))

            out_file = published_dir / rel
            out_file.parent.mkdir(parents=True, exist_ok=True)
            with out_file.open("w", encoding="utf-8") as f:
                for item in out_items:
                    f.write(json.dumps(item, ensure_ascii=False) + "\n")

            checkpoint.mark_published(key, PUBLISH_VERSION, src_hash)
            published += 1
        except Exception as e:
            print(f"[ERROR] {key}: {e}")
            failed += 1

    print(f"Published: {published}, Skipped: {skipped}, Failed: {failed}")


if __name__ == "__main__":
    main()
