"""extract 子命令入口。"""

import argparse
import json
from pathlib import Path

from checkpoint import RefineryCheckpoint
from config import RefineryConfig
from extract import Extractor
from llm import LLMClient
from markdown_scanner import MarkdownScanner, MarkdownSource


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="从 Markdown 提取题目或卡片")
    parser.add_argument("--input-dir", help="Markdown 输入目录（默认 tools/data-refinery/output/md）")
    parser.add_argument("--output-dir", help="提取结果输出目录（默认 tools/data-refinery/output/extracted）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
    parser.add_argument("--file", help="只提取匹配的文件（相对路径子串匹配，如 '2024/...西城-模拟二-试卷'）")
    parser.add_argument("--force", action="store_true", help="强制重新提取")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要处理的 Markdown")
    return parser.parse_args(argv)


def _load_prompt(kind: str) -> str:
    prompt_path = Path(__file__).with_suffix("").parent / "prompts" / f"{kind}.txt"
    return prompt_path.read_text(encoding="utf-8")


def _match_source(source: MarkdownSource, filter_value: str) -> bool:
    if filter_value == "all":
        return True
    # 用 md 文件名判断来源（而非所在目录名），与 scanner 的 kind 推断、
    # publish_cli 的过滤保持一致；避免扁平目录下目录名不含“试卷/答案”时误判。
    name = source.md_path.name
    if filter_value == "zgkao":
        return "试卷" in name or "答案" in name
    if filter_value == "smartedu":
        return "试卷" not in name and "答案" not in name
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


def main(argv=None):
    args = parse_args(argv)
    config = RefineryConfig.from_env(
        input_dir=None,
        output_dir=args.output_dir or None,
    )
    md_dir = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    extracted_dir = config.output_dir / "extracted"

    scanner = MarkdownScanner(md_dir)
    checkpoint = RefineryCheckpoint(config.output_dir / ".checkpoint.json")
    checkpoint.load()

    llm = LLMClient(
        provider=config.llm_provider,
        api_key=config.llm_api_key or "",
        auth_token=config.llm_auth_token,
        model=config.llm_model,
        base_url=config.llm_base_url,
        timeout=config.llm_timeout,
        max_tokens=config.llm_max_tokens,
    )

    sources = [s for s in scanner.scan() if _match_source(s, args.source)]
    if args.file:
        # 按相对路径子串过滤，只处理指定文件（如某份漏抽的试卷）
        sources = [s for s in sources if args.file in str(s.rel_path / s.md_path.name)]
    if args.dry_run:
        for s in sources:
            print(f"[dry-run] {s.rel_path / s.md_path.name} ({s.kind})")
        if not sources:
            print(f"[dry-run] 无文件匹配 --file={args.file!r}")
        return

    extracted = 0
    skipped = 0
    failed = 0
    total = len(sources)
    # per-book 当前 lesson_id：LLM 给标识（小节/章标题或 null），CLI 跨页、跨卡片继承 null。
    book_lesson: dict[str, str | None] = {}

    for idx, source in enumerate(sources, 1):
        # 文件级唯一键：目录 + md 文件名，确保同一本书的每一页都有独立的 checkpoint 与输出路径，
        # 避免教材扁平结构（多页共享同一 rel_path 目录）时第一页后其余页被 skip 或输出互相覆盖。
        rel_file = source.rel_path / source.md_path.name
        file_key = str(rel_file)
        book_key = str(source.rel_path)
        if not args.force and checkpoint.is_extracted(file_key):
            skipped += 1
            # 断点续传：从已抽页 jsonl 回填 per-book 状态，保证后续续页能继承
            if source.kind == "cards":
                last = _last_lesson_id(extracted_dir / rel_file.with_suffix(".jsonl"))
                if last is not None:
                    book_lesson[book_key] = last
            print(f"[skip] ({idx}/{total}) {file_key}", flush=True)
            continue
        try:
            prompt = _load_prompt("exam_questions" if source.kind == "questions" else "textbook_cards")
            extractor = Extractor(llm=llm, prompt=prompt, kind=source.kind)
            result = extractor.run(source.md_path)

            # cards：LLM 输出 lesson_id 为标题（新小节/章）或 null（续页/续卡片）。
            # CLI 按卡片顺序继承：非 null 更新 current，null 沿用 current；跨页靠 book_lesson 延续。
            if source.kind == "cards":
                current = book_lesson.get(book_key)
                for item in result.items:
                    if item.lesson_id:
                        current = item.lesson_id
                    else:
                        item.lesson_id = current
                book_lesson[book_key] = current

            if result.items:
                # 每份 md 镜像一个 jsonl（md 路径换后缀），多页教材各自独立、互不覆盖。
                out_file = extracted_dir / rel_file.with_suffix(".jsonl")
                out_file.parent.mkdir(parents=True, exist_ok=True)
                with out_file.open("w", encoding="utf-8") as f:
                    for item in result.items:
                        f.write(json.dumps(item.model_dump(mode="json"), ensure_ascii=False) + "\n")
                print(f"[ok] ({idx}/{total}) {file_key} -> {len(result.items)} items", flush=True)
            else:
                # 前置内容（封面/目录/版权等）不产出 card，但仍记 checkpoint 避免重抽
                print(f"[ok] ({idx}/{total}) {file_key} -> 0 items (front matter skipped)", flush=True)

            checkpoint.mark_extracted(file_key)
            extracted += 1
        except Exception as e:
            # flush=True：stdout 重定向到文件时为块缓冲，进程被 kill 会导致缓冲区丢失，
            # 错误信息必须即时落盘以便诊断（如长输出超时、解析失败等）。
            print(f"[ERROR] ({idx}/{total}) {file_key}: {e}", flush=True)
            failed += 1

    print(f"Extracted: {extracted}, Skipped: {skipped}, Failed: {failed}", flush=True)


if __name__ == "__main__":
    main()
