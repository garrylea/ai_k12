"""extract 子命令入口。

处理流程：image_scan → card_splitter → LLM card_labeler
- Python 程序拆分卡片（内容不动）
- LLM 仅标注（page_type / card_type / lesson_id / title）
"""

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

from card_labeler import CardLabeler
from card_splitter import split_page
from checkpoint import RefineryCheckpoint
from config import RefineryConfig
from image_scan import scan_page
from llm import create_llm_client
from markdown_scanner import MarkdownScanner, MarkdownSource
from models import TextbookCard

import re


def is_front_matter(text: str, page_num: int) -> bool:
    """确定性预过滤：识别目录页、版权页、空页等前置内容。

    在 LLM 标注之前调用，避免 gemma4 26B 误判。
    """
    lines = [l.strip() for l in text.splitlines() if l.strip()]

    # 1. 版权页
    if any(k in text for k in ["出版社", "仅供个人学习", "未经授权", "版权所有"]):
        return True

    # 2. 目录页：大量 "标题 数字" 行，或显式包含 "## 目录"
    if "## 目录" in text:
        return True
    toc_line_count = sum(
        1 for l in lines
        if re.search(r'[一二三四五六七八九十\d].+\s+\d{1,3}$', l)
    )
    if len(lines) > 0 and toc_line_count / len(lines) >= 0.3:
        return True

    # 3. 教材引言/前言页
    intro_headings = ["本册导引", "致同学", "编者的话", "出版说明", "序言"]
    if any(h in text for h in intro_headings):
        return True

    # 4. 空页或前置空白页（前 10 页内极短内容）
    if len(text.strip()) < 30 and page_num <= 10:
        return True

    return False


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="从 Markdown 提取教材卡片")
    parser.add_argument("--input-dir", help="Markdown 输入目录（默认 output/md）")
    parser.add_argument("--output-dir", help="输出根目录（JSONL 落 {该目录}/extracted/ 下；默认 output/extracted 所在的 output 根）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all")
    parser.add_argument("--file", help="只提取匹配的文件（相对路径子串匹配）")
    parser.add_argument("--pages", help="只提取指定页码，如 '1-6' 或 '1,3,5-8'")
    parser.add_argument("--book", help="只提取指定教材（路径子串匹配，如'九年级/上册'）")
    parser.add_argument("--force", action="store_true", help="强制重新提取（忽略 checkpoint，但不删除已有输出）")
    parser.add_argument("--reconvert", action="store_true", help="清除 checkpoint + 删除已有 JSONL，重新提取匹配页")
    parser.add_argument("--toc", help="TOC JSON 路径，用于校验 lesson_id + 自动修正（单文件模式）")
    parser.add_argument("--toc-dir", help="TOC JSON 目录（如 output/toc）：按书自动匹配注入 labeler prompt + 逐书后置校验；优先于 --toc")
    parser.add_argument("--interval", type=float, default=0.0,
                        help="每次 LLM 调用后 sleep 秒数（默认 0）")
    parser.add_argument("--batch-size", type=int, default=0,
                        help="每处理 N 页（发生 LLM 调用的页）后进入批次间歇（默认 0=不分批）")
    parser.add_argument("--batch-sleep", type=float, default=0.0,
                        help="批次之间 sleep 秒数（默认 0）")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要处理的 Markdown")
    return parser.parse_args(argv)


def _load_prompt(kind: str) -> str:
    prompt_path = Path(__file__).with_suffix("").parent / "prompts" / f"{kind}.txt"
    return prompt_path.read_text(encoding="utf-8")


def _match_source(source: MarkdownSource, filter_value: str) -> bool:
    if filter_value == "all":
        return True
    name = source.md_path.name
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


def _match_pages(md_name: str, page_nums: set[int]) -> bool:
    """Check if page_XXX.md matches any of the given page numbers."""
    import re
    m = re.search(r"page_(\d+)", md_name)
    if m:
        return int(m.group(1)) in page_nums
    return False


def _last_lesson_id(jsonl_path: Path) -> str | None:
    """读 jsonl 中最后一条非空 lesson_id，用于断点续传时回填 per-book 状态。

    续跑时已抽页会被 skip，若不回填状态，其后续页的续页 card 会丢上下文。
    """
    if not jsonl_path.exists():
        return None
    last = None
    for line in jsonl_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("lesson_id"):
            last = obj["lesson_id"]
    return last


def _levenshtein(a: str, b: str) -> int:
    """计算两个字符串的编辑距离（Levenshtein distance）。"""
    if len(a) < len(b):
        return _levenshtein(b, a)
    if len(b) == 0:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(
                prev[j] + 1,
                cur[-1] + 1,
                prev[j - 1] + (0 if ca == cb else 1),
            ))
        prev = cur
    return prev[-1]


def _flatten_toc_labels(toc: dict) -> list[str]:
    """从 TOC JSON 提取所有合法的 lesson_id 标签（扁平列表）。"""
    labels: list[str] = []
    for ch in toc.get("chapters", []):
        if ch.get("label"):
            labels.append(ch["label"])
        for sec in ch.get("sections", []):
            if sec.get("label"):
                labels.append(sec["label"])
            for sub in sec.get("subsections", []):
                if sub.get("label"):
                    labels.append(sub["label"])
        for supp in ch.get("supplements", []):
            if supp.get("label"):
                labels.append(supp["label"])
    return labels


def validate_and_correct(cards_by_file: dict, toc: dict, output_dir: Path) -> dict:
    """校验 card 的 lesson_id 与 TOC 的一致性，自动修正编辑距离 ≤2 的不匹配。

    Args:
        cards_by_file: {file_key: [card_dict, ...]}
        toc: parsed TOC JSON
        output_dir: directory for diff_report.json

    Returns:
        dict: diff_report with matched/corrected/unmatched/missing_from_cards/summary
    """
    toc_labels = _flatten_toc_labels(toc)
    diff_report = {
        "book": toc.get("book", ""),
        "matched": 0,
        "corrected": [],
        "unmatched": [],
        "missing_from_cards": list(toc_labels),
        "summary": "",
    }
    all_card_labels: set[str] = set()

    for file_key, cards in cards_by_file.items():
        for card in cards:
            lid = card.get("lesson_id")
            if not lid:
                continue
            all_card_labels.add(lid)

            if lid in toc_labels:
                diff_report["matched"] += 1
                if lid in diff_report["missing_from_cards"]:
                    diff_report["missing_from_cards"].remove(lid)
                continue

            # Fuzzy match: Levenshtein distance ≤ 2
            if not toc_labels:
                diff_report["unmatched"].append(lid)
                continue
            best = min(toc_labels, key=lambda t: _levenshtein(lid, t))
            dist = _levenshtein(lid, best)
            if dist <= 2:
                card["lesson_id"] = best
                diff_report["corrected"].append({
                    "original": lid, "corrected": best, "distance": dist,
                })
                if best in diff_report["missing_from_cards"]:
                    diff_report["missing_from_cards"].remove(best)
            else:
                diff_report["unmatched"].append(lid)

    diff_report["summary"] = (
        f"{diff_report['matched']} matched, "
        f"{len(diff_report['corrected'])} auto-corrected, "
        f"{len(diff_report['unmatched'])} unmatched, "
        f"{len(diff_report['missing_from_cards'])} missing (TOC has but cards don't)"
    )
    return diff_report


def _load_toc_cache(toc_dir: Path) -> dict[str, dict]:
    """扫描 TOC 目录，构建 book_key -> toc dict 缓存。

    book_key 为 TOC 文件相对 toc_dir 的路径（去 .json 后缀，posix 分隔），
    与 md 目录的书目录相对路径一致（toc_parse_cli 的输出命名规则）。
    跳过 toc_merge 的 sidecar（.merged.json / .merge_report.json）。
    """
    cache: dict[str, dict] = {}
    if not toc_dir.exists():
        print(f"[WARN] TOC 目录不存在: {toc_dir}", flush=True)
        return cache
    for p in sorted(toc_dir.rglob("*.json")):
        if p.name.endswith(".merged.json") or p.name.endswith(".merge_report.json"):
            continue
        key = p.relative_to(toc_dir).with_suffix("").as_posix()
        try:
            cache[key] = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            print(f"[WARN] 跳过无效 TOC 文件 {p}: {e}", flush=True)
    return cache


def _log_labeling_error(log_path: Path, file_key: str, attempt: str,
                        labeler, invalid: list | None = None,
                        error: str | None = None) -> None:
    """结构化记录标注失败（JSONL 追加），供事后分析原因。

    记录：时间 / 页 / 尝试阶段 / 模型 / 非法 card_type 原始值 / 异常 / LLM 原始输出。
    """
    rec = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "file": file_key,
        "attempt": attempt,
        "model": getattr(labeler, "model_name", str(labeler)),
        "invalid_card_types": [{"index": i, "value": v} for i, v in (invalid or [])],
        "error": error,
        "raw_response": getattr(labeler, "last_raw_content", None),
    }
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def _label_with_escalation(labeler, fallback_labeler,
                           cards_text: list[str], *, page_number: str,
                           prev_lesson_id: str | None, toc_labels: list[str] | None,
                           file_key: str, err_log_path: Path):
    """标注一页，card_type 非法时分级重试：主模型 → 主模型重试 → 兜底模型。

    每次失败（含网络/JSON 异常）都把详情记录到 err_log_path。

    Returns:
        (result, status)
        - status: "ok" | "retry_ok" | "fallback_ok" | "exhausted" | "error"
        - exhausted：所有尝试都返回非法 card_type；result 为最后一次结果
          （非法值已归一为 concept，可由调用方决定是否沿用）
        - error：所有尝试都抛异常；result=None，调用方走默认标注兜底
    """
    attempts = [("primary", labeler), ("primary-retry", labeler)]
    if fallback_labeler is not None:
        attempts.append(("fallback", fallback_labeler))

    status_map = {"primary": "ok", "primary-retry": "retry_ok", "fallback": "fallback_ok"}
    result = None
    for attempt, lab in attempts:
        try:
            res = lab.label(cards_text, page_number=page_number,
                            prev_lesson_id=prev_lesson_id, toc_labels=toc_labels)
        except Exception as e:
            _log_labeling_error(err_log_path, file_key, attempt, lab, error=str(e))
            continue
        if not res.invalid_card_types:
            return res, status_map[attempt]
        _log_labeling_error(err_log_path, file_key, attempt, lab, invalid=res.invalid_card_types)
        result = res
    return (result, "exhausted") if result is not None else (None, "error")


def _ask_continue_on_exhausted(file_key: str, invalid: list, log_path: Path,
                               input_fn=input) -> str:
    """分级重试全部失败后的处置：交互模式暂停询问，非交互模式页面计失败。

    Returns:
        "continue"（交互，用户选继续：本页用归一化标签）
        "stop"（交互，用户选停止：中断管线排查原因）
        "fail"（非交互无 TTY：页面计失败，下轮重试）
    """
    desc = ", ".join(f"卡#{i + 1}={v!r}" for i, v in invalid)
    print(f"[ERROR] {file_key}: card_type 超出允许范围（{desc}），"
          f"主模型重试 + 兜底模型均失败", flush=True)
    print(f"  详情与 LLM 原始输出已记录: {log_path}", flush=True)
    if not sys.stdin.isatty():
        return "fail"
    while True:
        raw = str(input_fn("继续吗? [c/回车=本页用归一化标签继续 / s=停止管线先排查原因]: ")).strip().lower()
        if raw in ("", "c"):
            return "continue"
        if raw == "s":
            return "stop"
        print("  请输入 c 或 s")


def main(argv=None):
    args = parse_args(argv)
    config = RefineryConfig.from_env(
        input_dir=None, output_dir=args.output_dir or None,
    )
    md_dir = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    extracted_dir = config.output_dir / "extracted"

    # --toc-dir：按书匹配的 TOC 缓存（注入 labeler + 逐书后置校验）
    toc_cache: dict[str, dict] = {}
    if args.toc_dir:
        toc_cache = _load_toc_cache(Path(args.toc_dir))

    scanner = MarkdownScanner(md_dir)
    checkpoint = RefineryCheckpoint(config.output_dir / ".checkpoint.json")
    checkpoint.load()

    llm = create_llm_client(
        provider=config.llm_provider,
        api_key=config.llm_api_key or "",
        auth_token=config.llm_auth_token,
        model=config.llm_model,
        base_url=config.llm_base_url,
        timeout=config.llm_timeout,
        max_tokens=config.llm_max_tokens,
        max_retries=config.llm_max_retries,
        thinking=config.llm_thinking,
        enable_cache=config.llm_enable_cache,
    )
    prompt = _load_prompt("textbook_cards")
    labeler = CardLabeler(llm=llm, prompt_template=prompt)

    # 兜底模型：card_type 非法且主模型重试仍失败时再升级一次（LLM_FALLBACK_* 配置）
    fallback_labeler = None
    if config.llm_fallback_provider:
        try:
            fb_llm = create_llm_client(
                provider=config.llm_fallback_provider,
                api_key=config.llm_fallback_api_key or "",
                model=config.llm_fallback_model,
                base_url=config.llm_fallback_base_url,
                timeout=config.llm_timeout,
                max_tokens=config.llm_max_tokens,
                max_retries=config.llm_max_retries,
            )
            fallback_labeler = CardLabeler(llm=fb_llm, prompt_template=prompt)
            print(f"[fallback] 标注兜底模型就绪: "
                  f"{config.llm_fallback_provider} / {config.llm_fallback_model}", flush=True)
        except Exception as e:
            print(f"[WARN] 兜底模型初始化失败（{e}），仅主模型重试", flush=True)

    # 标注失败记录（结构化 JSONL，供分析偶发幻觉的原因）
    err_log_path = config.output_dir / "labeling_errors.jsonl"

    sources = [s for s in scanner.scan() if _match_source(s, args.source)]
    if args.file:
        sources = [s for s in sources if args.file in str(s.rel_path / s.md_path.name)]
    if args.pages:
        page_nums = _parse_pages(args.pages)
        sources = [s for s in sources if _match_pages(s.md_path.name, page_nums)]
    if args.book:
        sources = [s for s in sources if args.book in str(s.rel_path)]
    if args.dry_run:
        for s in sources:
            print(f"[dry-run] {s.rel_path / s.md_path.name} ({s.kind})")
        return

    # --reconvert：清理匹配页的 checkpoint + 删除已有 JSONL
    if args.reconvert:
        cleared = 0
        for source in sources:
            rel_file = source.rel_path / source.md_path.name
            file_key = str(rel_file)
            if checkpoint.is_extracted(file_key):
                checkpoint.unmark_extracted(file_key)
            out_file = extracted_dir / rel_file.with_suffix(".jsonl")
            if out_file.exists():
                out_file.unlink()
                print(f"[reconvert] deleted {out_file}", flush=True)
            cleared += 1
        print(f"[reconvert] cleared checkpoint for {cleared} source(s)", flush=True)

    # Per-book state: 跨页 lesson_id 继承
    book_lesson: dict[str, str | None] = {}

    total_processed = len(sources)
    extracted = 0
    skipped = 0
    failed = 0
    llm_calls = 0  # 仅统计真正发生 LLM 调用的页，用于节流

    for idx, source in enumerate(sources, 1):
        rel_file = source.rel_path / source.md_path.name
        file_key = str(rel_file)
        book_key = str(source.rel_path)

        if not args.force and not args.reconvert and checkpoint.is_extracted(file_key):
            skipped += 1
            # 断点续传：从已抽页 jsonl 回填 per-book 状态，保证后续续页能继承
            if source.kind == "cards":
                last = _last_lesson_id(extracted_dir / rel_file.with_suffix(".jsonl"))
                if last is not None:
                    book_lesson[book_key] = last
            print(f"[skip] ({idx}/{total_processed}) {file_key}", flush=True)
            continue

        try:
            # ① 前置页预过滤（确定性规则，避免 LLM 误判）
            text = source.md_path.read_text(encoding="utf-8")
            _m = re.search(r"page_(\d+)", source.md_path.name)
            page_num = int(_m.group(1)) if _m else 0
            if is_front_matter(text, page_num):
                checkpoint.mark_extracted(file_key)
                print(f"[ok] ({idx}/{total_processed}) {file_key} -> 0 items (front matter)", flush=True)
                extracted += 1
                continue

            # ② image_scan：获取图片尺寸 + 折算字数（小图标自动舍弃，text 已清洗）
            images, text = scan_page(source.md_path)

            # ③ card_splitter：拆分卡片
            cards = split_page(source.md_path, text, images)

            if not cards:
                # 空页，跳过
                checkpoint.mark_extracted(file_key)
                print(f"[ok] ({idx}/{total_processed}) {file_key} -> 0 items (empty)", flush=True)
                extracted += 1
                continue

            # ③ card_labeler：LLM 标注
            page_num = cards[0].textbook_page.replace("P", "") if cards else ""
            prev = book_lesson.get(book_key)

            # 节流：在调用前（跳过首次）按批次/间隔 sleep
            if llm_calls > 0:
                if args.batch_size > 0 and llm_calls % args.batch_size == 0:
                    if args.batch_sleep > 0:
                        print(f"[throttle] batch of {args.batch_size} done, sleeping {args.batch_sleep}s", flush=True)
                        time.sleep(args.batch_sleep)
                elif args.interval > 0:
                    time.sleep(args.interval)
            llm_calls += 1

            cards_text = [c.content for c in cards]
            toc_labels = (_flatten_toc_labels(toc_cache[book_key])
                          if book_key in toc_cache else None)
            result, status = _label_with_escalation(
                labeler, fallback_labeler, cards_text,
                page_number=f"P{page_num}", prev_lesson_id=prev,
                toc_labels=toc_labels, file_key=file_key,
                err_log_path=err_log_path)

            if result is None:
                # 所有尝试均异常（网络/JSON 等）：默认标注兜底（与旧版行为一致）
                print(f"[WARN] ({idx}/{total_processed}) {file_key}: "
                      f"LLM label failed (all attempts), using defaults", flush=True)
                from card_labeler import LabelResult, PageLabelResult
                result = PageLabelResult(
                    page_type="front_matter",
                    labels=[LabelResult(
                        page_type="front_matter", card_type="concept",
                        lesson_id=prev, title=None,
                        textbook_page=f"P{page_num}",
                    ) for _ in cards],
                )
            elif status == "exhausted":
                # 主模型 + 重试 + 兜底模型均返回非法 card_type：报错并交由用户/环境决定
                action = _ask_continue_on_exhausted(
                    file_key, result.invalid_card_types, err_log_path)
                if action == "stop":
                    print(f"[中断] 用户选择停止。失败详情见 {err_log_path}", flush=True)
                    raise SystemExit(1)
                if action == "fail":
                    # 非交互：页面计失败（不写 jsonl / 不记 checkpoint，下轮重试）
                    print(f"[ERROR] ({idx}/{total_processed}) {file_key}: "
                          f"重试穷尽，本页计为失败", flush=True)
                    failed += 1
                    continue
                print(f"[WARN] ({idx}/{total_processed}) {file_key}: "
                      f"重试穷尽，用户选择以归一化标签继续本页", flush=True)
            elif status != "ok":
                print(f"[WARN] ({idx}/{total_processed}) {file_key}: "
                      f"card_type 超范围，{status} 后成功", flush=True)

            # 前置内容跳过
            if result.page_type == "front_matter":
                checkpoint.mark_extracted(file_key)
                print(f"[ok] ({idx}/{total_processed}) {file_key} -> 0 items (front matter)", flush=True)
                extracted += 1
                continue

            # ④ 组装 TextbookCard
            items = []
            for card, label in zip(cards, result.labels):
                # lesson_id 继承逻辑
                lesson_id = label.lesson_id
                if lesson_id:
                    book_lesson[book_key] = lesson_id
                else:
                    lesson_id = book_lesson.get(book_key)

                # title 去重：若 content 首行是 `#/## {title}`，从 content 剥离，
                # 标题由前端用 title 字段渲染 H2，避免出现两次。
                content = card.content
                title = label.title
                if title:
                    for marker in ("## ", "# "):
                        if content.startswith(f"{marker}{title}"):
                            content = content[len(f"{marker}{title}"):].lstrip("\n")
                            break

                # practice 卡：把 groups 放进 content_metadata，
                # 后续 publish 追加 images，db_loader 做子串校验并落库。
                content_metadata = None
                if label.card_type == "practice":
                    if label.groups is not None:
                        content_metadata = {"groups": label.groups}

                items.append(TextbookCard(
                    lesson_id=lesson_id,
                    sort_order=card.sort_order,
                    card_type=label.card_type,
                    title=title,
                    content=content,
                    content_metadata=content_metadata,
                    knowledge_point_ids=[],
                    textbook_page=label.textbook_page or card.textbook_page,
                ))

            # ⑤ 写入 JSONL
            if items:
                out_file = extracted_dir / rel_file.with_suffix(".jsonl")
                out_file.parent.mkdir(parents=True, exist_ok=True)
                with out_file.open("w", encoding="utf-8") as f:
                    for item in items:
                        f.write(json.dumps(item.model_dump(mode="json"), ensure_ascii=False) + "\n")
                print(f"[ok] ({idx}/{total_processed}) {file_key} -> {len(items)} items", flush=True)
            else:
                print(f"[ok] ({idx}/{total_processed}) {file_key} -> 0 items", flush=True)

            checkpoint.mark_extracted(file_key)
            extracted += 1
        except Exception as e:
            print(f"[ERROR] ({idx}/{total_processed}) {file_key}: {e}", flush=True)
            failed += 1

    # --toc-dir：逐书后置校验（模糊修正写回 jsonl；不写 diff_report，
    # 由 toc_merge 的 merge_report 取代；修正发生时清 publish checkpoint 让下轮重发）
    if toc_cache:
        book_keys: list[str] = []
        for source in sources:
            if source.kind == "cards":
                bk = str(source.rel_path)
                if bk in toc_cache and bk not in book_keys:
                    book_keys.append(bk)
        for bk in book_keys:
            cards_by_file: dict[str, list] = {}
            for source in sources:
                if str(source.rel_path) != bk:
                    continue
                rel_file = source.rel_path / source.md_path.name
                out_file = extracted_dir / rel_file.with_suffix(".jsonl")
                if out_file.exists():
                    items = [json.loads(l) for l in
                             out_file.read_text(encoding="utf-8").splitlines() if l.strip()]
                    if items:
                        cards_by_file[str(rel_file)] = items
            if not cards_by_file:
                continue
            report = validate_and_correct(cards_by_file, toc_cache[bk], extracted_dir)
            if report["corrected"]:
                for file_key, cards in cards_by_file.items():
                    out_file = extracted_dir / file_key.replace(".md", ".jsonl")
                    with out_file.open("w", encoding="utf-8") as f:
                        for item in cards:
                            f.write(json.dumps(item, ensure_ascii=False) + "\n")
                    # jsonl 已改写：若已 publish 过需清除标记，下轮 publish 重发
                    if checkpoint.is_published(file_key):
                        checkpoint.unmark_published(file_key)
            print(f"[toc-dir] {bk}: {report['summary']}", flush=True)

    # --toc：校验 + 自动修正（在所有 JSONL 写入完成后；--toc-dir 优先，两者都给时忽略本参数）
    if args.toc and not args.toc_dir:
        toc_path = Path(args.toc)
        if toc_path.exists():
            toc = json.loads(toc_path.read_text(encoding="utf-8"))
            # 收集所有已写入的 cards
            cards_by_file = {}
            for source in sources:
                rel_file = source.rel_path / source.md_path.name
                out_file = extracted_dir / rel_file.with_suffix(".jsonl")
                if out_file.exists():
                    items = [json.loads(l) for l in out_file.read_text(encoding="utf-8").splitlines() if l.strip()]
                    if items:
                        cards_by_file[str(rel_file)] = items
            report = validate_and_correct(cards_by_file, toc, extracted_dir)
            # 写回修正后的 cards
            for file_key, cards in cards_by_file.items():
                out_file = extracted_dir / file_key.replace(".md", ".jsonl")
                with out_file.open("w", encoding="utf-8") as f:
                    for item in cards:
                        f.write(json.dumps(item, ensure_ascii=False) + "\n")
            # 输出 diff report
            report_path = extracted_dir / "diff_report.json"
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[toc] diff report: {report['summary']}", flush=True)
        else:
            print(f"[WARN] TOC file not found: {args.toc}", flush=True)

    print(f"Extracted: {extracted}, Skipped: {skipped}, Failed: {failed}", flush=True)


if __name__ == "__main__":
    main()
