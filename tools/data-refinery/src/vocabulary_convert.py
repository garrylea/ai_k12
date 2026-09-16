"""把英语课本的**书末若干页**（单词表所在段）交给 MinerU 转 md。

这是词库管线的第一步：`vocabulary_convert`(本文件，MinerU 转 md)
→ `vocabulary_book`(md → 词条) → `vocabulary_loader`(校验/去重/入库)。

为什么只转书末：人教版初中/高中都把单词表放在书末附录，整本转是 3 倍浪费
（MinerU 是云 API，约 6 秒/页）。若某本在书末找不到单词表，再回头加页重转。
"""
import pathlib
import subprocess
import sys

CRAWL = pathlib.Path(__file__).resolve().parents[2] / "crawler" / "data" / "英语"
OUT = pathlib.Path(__file__).resolve().parent.parent / "output" / "vocabulary_md"
TAIL = 48          # 书末取多少页
BATCH = 12         # MinerU 限速约 50 文件/分，分批 + 间歇

books = sorted(p.parent for p in CRAWL.rglob("page_001.jpg"))
print(f"共 {len(books)} 本\n", flush=True)

for bi, book in enumerate(books, 1):
    pages = sorted(book.glob("page_*.jpg"))
    if len(pages) < 60:                     # 之前下载被打断的残本，跳过
        print(f"[{bi}/{len(books)}] 跳过（仅 {len(pages)} 页，疑为残本）：{book.name}", flush=True)
        continue
    tail = pages[-TAIL:]
    dest = OUT / f"{book.relative_to(CRAWL).as_posix().replace('/', '__')}"
    dest.mkdir(parents=True, exist_ok=True)
    print(f"[{bi}/{len(books)}] {book.name}：{len(tail)} 页 -> {dest.name}", flush=True)

    for i in range(0, len(tail), BATCH):
        batch = tail[i:i + BATCH]
        cmd = ["mineru-open-api", "extract", *[str(p) for p in batch], "-o", str(dest), "--ocr"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        ok = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "(no stdout)"
        print(f"    {i + len(batch)}/{len(tail)}  {ok}", flush=True)
        if r.returncode != 0:
            print(f"    !! 退出码 {r.returncode}: {r.stderr.strip()[:300]}", flush=True)

print("\n全部完成", flush=True)
