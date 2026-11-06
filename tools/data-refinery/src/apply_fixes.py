"""把人工补的题统一写入 MySQL（src/fix_question_cli.py 的产物）。

规则：
- 以 (paper_id, group_order) 定位题目；该题号已有行 → 原址更新，没有 → 新增并挂到卷上；
- 人工确认过的题一律 `is_active=1`、`needs_review=0`（人工就是那道复核门）；
- 写完后按 group_order 重排该卷的 question_no，保证卷内顺序与卷面题号一致；
- 幂等：`applied=true` 的记录跳过，重复执行不会插重。

用法：
    python3 src/apply_fixes_cli.py --dry-run      # 预览会改哪些题
    python3 src/apply_fixes_cli.py --apply        # 真正写库
"""

import argparse
import copy
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

import pymysql  # noqa: E402

from asset_store import LocalAssetStore  # noqa: E402
from checkpoint import RefineryCheckpoint  # noqa: E402
from config import RefineryConfig  # noqa: E402
from db_loader import content_hash  # noqa: E402
from image_rewrite import MissingImageError, rewrite_fields  # noqa: E402
from manual_fix import mark_issue  # noqa: E402
from scope_filter import match_keyword  # noqa: E402
from subject_codes import subject_code_for_parts  # noqa: E402

FIXES_DIR = ROOT / "output" / "manual_fixes"

_IMG_REF_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")


def _source_key(rec: dict) -> str:
    """与 publish 一致的源稳定键：``rel_path/source`` 的 md5 前 8 位。"""
    key = f"{rec.get('rel_path', '')}/{rec.get('source', '')}"
    return hashlib.md5(key.encode("utf-8")).hexdigest()[:8]


def _has_images(*texts, options=None) -> bool:
    for t in texts:
        if t and _IMG_REF_RE.search(t):
            return True
    for opt in options or []:
        if _IMG_REF_RE.search(opt.get("text") or ""):
            return True
    return False


def _patch_extracted(rec: dict, *, content: str, answer: str,
                     material_text, options, output_dir: Path) -> None:
    """把补好的题写回 extracted，保证下次 publish/loader 看到同一份题号。

    为什么必须回写：补题原先只写库，published 仍按旧题号（缺题的位置是空洞）。
    下一次 import 会用 published 的 group_order 去对齐库，一错位就会把人工补的题
    当成「旧残题」摘掉（2026-10-31 第 4 题脐橙事故）。回写后由 publish 重新物化、
    db_loader 按同一编号对齐，补题不会再被下一次导入冲掉。

    找不到 extracted（例如只在测试里喂了假路径）时只告警、不影响写库。
    """
    rel, src = rec.get("rel_path"), rec.get("source")
    if not rel or not src:
        print("[WARN] 补题记录缺少 rel_path/source，跳过 extracted 回写", flush=True)
        return
    path = output_dir / "extracted" / rel / f"{src}.jsonl"
    if not path.exists():
        print(f"[WARN] 找不到 extracted 产物，跳过回写：{path}", flush=True)
        return

    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    go = int(rec["group_order"])
    payload = {
        "group_order": go,
        "type": rec.get("expected_type") or ("choice" if options else "short_answer"),
        "difficulty": 2,
        "content": content,
        "options": options,
        "answer": answer,
        "material_text": material_text,
        "needs_review": False,
    }
    pos = next((i for i, r in enumerate(rows) if int(r.get("group_order") or -1) == go), None)
    if pos is None:
        pos = next((i for i, r in enumerate(rows) if int(r.get("group_order") or 0) > go), len(rows))
        sibling = rows[pos] if pos < len(rows) else (rows[-1] if rows else {})
        rows.insert(pos, {
            "subject_id": sibling.get("subject_id") or subject_code_for_parts(Path(rel).parts, default=""),
            "group_id": None,
            "full_score": sibling.get("full_score"),
            "grade_band": sibling.get("grade_band") or "junior",
            "source": src,
            "source_year": sibling.get("source_year"),
            **payload,
        })
    else:
        rows[pos] = {**rows[pos], **payload}

    path.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )
    # 让 publish 下次重发这份卷（否则 checkpoint 会跳过，published 还是旧题号）
    checkpoint = RefineryCheckpoint(output_dir / ".publish_checkpoint.json")
    checkpoint.load()
    checkpoint.unmark_published(f"{rel}/{src}")
    print(f"[INFO] 已回写 extracted 并标记重发：{path}", flush=True)


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def _subject_id(cur, rel_path: str) -> int | None:
    code = subject_code_for_parts(Path(rel_path).parts, default="")
    if not code:
        return None
    cur.execute("SELECT id FROM subjects WHERE code=%s", (code,))
    row = cur.fetchone()
    return int(row[0]) if row else None


def _paper_row(cur, rel_path: str, source: str) -> tuple[int, int] | None:
    """返回 (paper_id, subject_id)；按 source_key 精确匹配。"""
    key = f"{rel_path}/{source}"
    cur.execute("SELECT id, subject_id FROM exam_papers WHERE source_key=%s", (key,))
    row = cur.fetchone()
    if row:
        return int(row[0]), int(row[1])
    return None


def _existing_question(cur, paper_id: int, group_order: int) -> int | None:
    cur.execute(
        "SELECT question_id FROM paper_questions WHERE paper_id=%s AND group_order=%s",
        (paper_id, group_order))
    row = cur.fetchone()
    return int(row[0]) if row else None


def _orphan_question(cur, paper_id: int, source: str, group_order: int) -> int | None:
    """同一份卷、同一题号、当前没挂在卷上的旧行（人工补的第一版 / 上一轮导入的残行）。

    为什么要找它：题号已经存在于库、只是关联被重导摘掉了。这时必须**更新那一行**，
    再 INSERT 就会在同一份卷里出现两道 18 题（2026-11-01 人大附实测：6338/6340/6341
    就是这样变成孤儿的）。「内容变了」不是新建的理由 —— 卷内题号就是这道题的身份。
    """
    cur.execute(
        "SELECT q.id FROM questions q "
        "WHERE q.source=%s AND q.group_order=%s "
        "  AND NOT EXISTS (SELECT 1 FROM paper_questions pq WHERE pq.question_id=q.id) "
        "ORDER BY q.id LIMIT 1",
        (source, group_order))
    row = cur.fetchone()
    return int(row[0]) if row else None


def _duplicate_numbers(cur, paper_id: int) -> list[int]:
    """同一份卷里挂了两个以上 question_no 的题号（组卷会出现同号题，必须为 0）。"""
    cur.execute(
        "SELECT question_no FROM paper_questions WHERE paper_id=%s "
        "GROUP BY question_no HAVING COUNT(*) > 1 ORDER BY question_no",
        (paper_id,))
    return [int(r[0]) for r in cur.fetchall()]


def _renumber(cur, paper_id: int) -> int:
    """按卷面题号重排 question_no，返回受影响行数。

    与 db_loader 同一口径：`question_no = COALESCE(group_order, 行序)`，
    所以补回缺题后题号会对上（而不是把空缺挤掉、整卷顺序错位）。
    """
    cur.execute(
        "UPDATE paper_questions pq JOIN ("
        "  SELECT question_id, ROW_NUMBER() OVER (ORDER BY group_order, question_no) rn"
        "  FROM paper_questions WHERE paper_id=%s) t"
        " ON t.question_id = pq.question_id "
        "SET pq.question_no = COALESCE(pq.group_order, t.rn) "
        "WHERE pq.paper_id=%s",
        (paper_id, paper_id))
    return cur.rowcount


def pending_records(subject: str | None = None, source: str | None = None,
                    fixes_dir: Path | None = None) -> list[dict]:
    """还没写进库的补题记录（applied!=True），可按学科 / 卷名子串收窄。"""
    out: list[dict] = []
    for f in sorted(Path(fixes_dir or FIXES_DIR).glob("*.jsonl")):
        for rec in _read_jsonl(f):
            if rec.get("applied"):
                continue
            if subject and Path(rec.get("rel_path", "")).parts[:1] != (subject,):
                continue
            if source and not match_keyword(rec.get("source", ""), source):
                continue
            rec["_file"] = str(f)
            out.append(rec)
    return out


def needing_replay(subject: str | None = None, source: str | None = None,
                   fixes_dir: Path | None = None) -> list[dict]:
    """已标 applied、但库里已经不成立（题没了 / 被停用）的补题记录。

    给 import_cli 第 8 步做闸门用：只看 `pending_records` 会漏掉「补过、后来被重导
    冲掉」的记录（它们 applied=true），于是正常导入也不会去救 —— 2026-11-01 人大附
    7/16/18/23 就是这样永久消失的。
    """
    recs: list[dict] = []
    for f in sorted(Path(fixes_dir or FIXES_DIR).glob("*.jsonl")):
        for rec in _read_jsonl(f):
            if not rec.get("applied"):
                continue
            if subject and Path(rec.get("rel_path", "")).parts[:1] != (subject,):
                continue
            if source and not match_keyword(rec.get("source", ""), source):
                continue
            rec["_file"] = str(f)
            recs.append(rec)
    if not recs:
        return []
    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4",
                           autocommit=True)
    try:
        with conn.cursor() as cur:
            return [r for r in recs if _replay_reason(cur, r)]
    finally:
        conn.close()


def apply_record(cur, rec: dict, apply: bool, *, assets_root: Path | None = None,
                 output_dir: Path | None = None) -> str:
    from manual_fix import looks_like_ui_echo

    if looks_like_ui_echo(rec.get("content") or ""):
        return "跳过：内容疑似终端界面文字（不是真题），请重新补录"
    found = _paper_row(cur, rec["rel_path"], rec["source"])
    if not found:
        return "跳过：库里没有这份卷（先跑 import_cli 入库）"
    paper_id, subject_id = found
    go = int(rec["group_order"])
    qid = _existing_question(cur, paper_id, go)
    orphan = False
    if qid is None:
        # 题号在库、只是关联被摘掉（重导/旧版补题）：更新那一行，别新建同号题
        qid = _orphan_question(cur, paper_id, rec.get("source", ""), go)
        orphan = qid is not None
    # 没有挂到卷上时，可能是「新增」，也可能是「复用」一条同内容的遗留行（重导摘了关联、
    # 没删题）。真正的选择要等内容物化后算哈希才知道，预览先把这个可能说清楚。
    action = "更新" if qid else "新增（同内容已存在则复用）"

    if not apply:
        # 预览要能判断"内容对不对"，只报更新/新增没用（用户 2026-10-31 指出）
        detail = (f"{action}：paper={paper_id} 第{go}题（question_id={qid or '—'}）"
                  f" · 新内容 {len(rec.get('content') or '')} 字")
        if qid:
            cur.execute("SELECT CHAR_LENGTH(content) FROM questions WHERE id=%s", (qid,))
            row = cur.fetchone()
            if row and row[0] is not None:
                detail += f"（原来 {int(row[0])} 字）"
        snippet = (rec.get("content") or "").replace("\n", " ")[:36]
        return f"{detail}\n        内容：{snippet}…"

    content = rec["content"]
    answer = rec.get("answer") or ""
    material_text = rec.get("material_text")
    options = rec.get("options")
    forced_type = rec.get("expected_type") or None

    # 手录时容易漏掉图片语法的 `!`（写成 `[](images/...)` 而不是 `![](images/...)`），
    # 导致：① rewrite_fields 不认它为图片 → 不物化；② 前端渲染成空链接 → 选项消失。
    # 入库前统一补 `!`（2026-11-01 人大附题9 C 项实测）。
    _MISSING_BANG_RE = re.compile(r"(?<!\!)\[\]\(images/")
    if content:
        content = _MISSING_BANG_RE.sub("![](images/", content)
    if options:
        for o in options:
            t = o.get("text") or ""
            if t:
                o["text"] = _MISSING_BANG_RE.sub("![](images/", t)
    # extracted 要保留**md 原始引用**（images/...），物化只发生在 publish。
    # rewrite_fields 会原地改写 options，所以先深拷贝一份原始值用于回写。
    raw_content, raw_answer = content, answer
    raw_material = material_text
    raw_options = copy.deepcopy(options) if options else options

    # 补题内容里的图是 md 相对路径（images/xxx.jpg），前端只认物化后的规范路径。
    # 落库前必须走与 publish 同一套改写 + 拷贝，否则库里留下必然 404 的路径
    # （2026-10-31 北师大实验第 3/4 题事故）。strict=True：缺源图直接拒绝，不静默。
    if _has_images(content, answer, material_text, options=options):
        md = rec.get("md")
        if not md:
            return "跳过：题目含图片但补题记录缺少 md 路径，无法物化"
        code = subject_code_for_parts(Path(rec["rel_path"]).parts, default="")
        prefix = f"questions/{code}/{_source_key(rec)}/{go}"
        try:
            content, answer, _exp, material_text, options, _mat = rewrite_fields(
                content=content,
                answer=answer,
                explanation=None,
                material_text=material_text,
                options=options,
                md_images_dir=Path(md).parent,
                asset_store=LocalAssetStore(assets_root or (RefineryConfig.from_env().output_dir / "assets")),
                asset_prefix=prefix,
                strict=True,
            )
        except MissingImageError as e:
            return f"跳过：{e}"

    chash = content_hash(content, options)
    _patch_extracted(
        rec, content=raw_content, answer=raw_answer,
        material_text=raw_material, options=raw_options,
        output_dir=output_dir or RefineryConfig.from_env().output_dir,
    )
    if qid:
        cur.execute(
            "UPDATE questions SET content=%s, options=%s, "
            "type=COALESCE(%s, IF(%s,'choice',type)), "
            "answer=COALESCE(NULLIF(%s,''), answer), material_text=%s, "
            "content_hash=%s, is_active=1 WHERE id=%s",
            (content,
             json.dumps(options, ensure_ascii=False) if options else None,
             forced_type, 1 if options else 0,
             answer, material_text, chash, qid))
        if orphan:
            # 旧行没挂在卷上：把卷内的题号关系补回来（内容已更新，不新建行）
            cur.execute(
                "INSERT IGNORE INTO paper_questions "
                "(paper_id, question_id, question_no, group_order) VALUES (%s,%s,%s,%s)",
                (paper_id, qid, go, go))
            action = "更新（复用同号旧行，未新建）"
    else:
        # 同一道题的行可能还在（重导只摘了 paper_questions 关联、没删题）：
        # 直接复用并重新挂到卷上。不加这一步，UNIQUE(content_hash) 会挡下 INSERT
        # （2026-11-01 人大附 7/16/18/23 实测：四个 hash 与留在库里的 6338–6341 完全相同）。
        cur.execute("SELECT id FROM questions WHERE content_hash=%s", (chash,))
        reused = cur.fetchone()
        if reused:
            qid = int(reused[0])
            action = "复用"
            cur.execute(
                "UPDATE questions SET content=%s, options=%s, "
                "type=COALESCE(%s, IF(%s,'choice',type)), "
                "answer=COALESCE(NULLIF(%s,''), answer), material_text=%s, is_active=1 "
                "WHERE id=%s",
                (content,
                 json.dumps(options, ensure_ascii=False) if options else None,
                 forced_type, 1 if options else 0,
                 answer, material_text, qid))
            cur.execute(
                "INSERT IGNORE INTO paper_questions "
                "(paper_id, question_id, question_no, group_order) VALUES (%s,%s,%s,%s)",
                (paper_id, qid, go, go))
        else:
            action = "新增"
            cur.execute(
                "INSERT INTO questions (subject_id, group_order, type, difficulty, content, options, "
                "answer, material_text, grade_band, source, source_year, content_hash, is_active) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1)",
                (subject_id, go, forced_type or ("choice" if options else "short_answer"), 2,
                 content,
                 json.dumps(options, ensure_ascii=False) if options else None,
                 answer, material_text,
                 "junior", rec["source"], 2024, chash))
            qid = int(cur.lastrowid)
            cur.execute(
                "INSERT IGNORE INTO paper_questions (paper_id, question_id, question_no, group_order) "
                "VALUES (%s,%s,%s,%s)", (paper_id, qid, go, go))

    _renumber(cur, paper_id)
    cur.execute("UPDATE exam_papers SET question_count=(SELECT COUNT(*) FROM paper_questions "
                "WHERE paper_id=%s) WHERE id=%s", (paper_id, paper_id))
    dup = _duplicate_numbers(cur, paper_id)
    if dup:
        print(f"[WARN] paper={paper_id} 卷内题号重复：{dup}（组卷会出现同号题，请检查）",
              flush=True)
    # 记下写入时的内容哈希：下次重导若把这道题的内容换回旧的，能立刻发现并重放
    rec["applied_hash"] = chash
    return f"{action}：paper={paper_id} 第{go}题 -> question_id={qid}"


def _replay_reason(cur, rec: dict) -> str | None:
    """补题记录标了 applied，但这道题在库里已经不是「人工确认过」的状态了。

    两种表现（2026-11-01 人大附实测，都是一次重导造成的）：
    - 库里根本没有这道题（人工补的 4 行被重导从 published 重建时摘掉）；
    - 有这道题，但 `is_active=0`（重导按 `needs_review=true` 重新停用，人工修复被覆盖）。

    为什么必须查库：`applied=true` 只证明「当时写过库」，不证明「现在还活着」。
    不查就永远不会重放，题就这么永久消失/停用。
    """
    found = _paper_row(cur, rec.get("rel_path", ""), rec.get("source", ""))
    if not found:
        return None        # 卷自身不在库里：交给 apply_record 报「跳过」，不猜
    try:
        go = int(rec["group_order"])
    except (TypeError, ValueError):
        return None
    cur.execute(
        "SELECT q.id, q.is_active, q.content_hash FROM paper_questions pq "
        "JOIN questions q ON q.id = pq.question_id "
        "WHERE pq.paper_id=%s AND pq.group_order=%s", (found[0], go))
    row = cur.fetchone()
    if not row:
        return "库中已无此题"
    if not int(row[1] or 0):
        return "库里这题被标为停用（is_active=0）"
    # 重导会把人工补的内容换回切题产物里的旧版本；哈希对不上就是被覆盖了
    applied_hash = rec.get("applied_hash")
    if applied_hash and row[2] and row[2] != applied_hash:
        return "库里这题的内容已被重新导入覆盖"
    return None


def _rescan(applied: dict[str, dict[str, set[int]]]) -> None:
    """写完就地复扫刚改过的卷：把清单状态（recorded → resolved / 重新打开）一次收口。

    写库后不复查，清单会停在「已补录未写库」；更要紧的是**补坏了要当场说**：
    内容仍缺小问/仍装错题时会被扫描重新打开，如果只在下一次导入时弹出来，
    用户看到的就是「同一题反复问我」。这里写完立刻点名。

    为什么内置：用户不该记第二条命令（2026-11-01 用户裁决「命令只能一条」）。
    """
    if not applied:
        return
    from recognition_scan import run as scan_run

    print("\n[复扫] 核对刚写入的卷：", flush=True)
    for subject_cn, by_source in sorted(applied.items()):
        sources = set(by_source)
        try:
            scan_run(subject_cn, None, write=True, sources=sources)
        except Exception as exc:          # noqa: BLE001 - 复扫失败不能影响已提交的数据
            print(f"[WARN] 复扫失败（数据已写入，不影响）：{exc}", flush=True)
            continue
        # 刚写的题如果又被重新打开，明确说清楚：不是重复打扰，是上次录的内容没修好
        path = Path(__file__).resolve().parents[1] / "output" / "recognition_issues.jsonl"
        try:
            rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()
                    if l.strip()]
        except OSError:
            continue
        for r in rows:
            src = r.get("source")
            if (src in by_source and r.get("status") == "pending"
                    and int(r.get("group_order") or -1) in by_source[src]
                    and "仍能检出" in (r.get("note") or "")):
                print(f"[!] 第 {r['group_order']} 题：写入的内容仍能检出同一问题"
                      f"（{r.get('note')}），已退回待处理 —— 上次录的内容没修好，"
                      f"请对照原卷补全后再录一次", flush=True)


def run(argv=None, *, via_pipeline: bool = False) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixes-dir", default=str(FIXES_DIR))
    parser.add_argument("--subject", help="学科中文名过滤（按 rel_path 首段）")
    parser.add_argument("--source", help="卷名子串过滤（如 一零一中学）")
    parser.add_argument("--apply", action="store_true", help="真正写库（默认只预览）")
    parser.add_argument("--dry-run", action="store_true", help="只预览（与默认行为一致，便于显式声明）")
    parser.add_argument("--force", action="store_true", help="连 applied=true 的记录也重放")
    args = parser.parse_args(argv)
    if args.apply and args.dry_run:
        parser.error("--apply 与 --dry-run 互斥")

    files = sorted(Path(args.fixes_dir).glob("*.jsonl"))
    if not files:
        print(f"[done] {args.fixes_dir} 下没有补题记录", flush=True)
        return 0

    cfg = RefineryConfig.from_env()
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4",
                           autocommit=False)
    total = 0
    previewed = 0
    applied_keys: list[tuple[str, int, str]] = []
    rejected_keys: list[tuple[str, int, str]] = []
    applied_sources: dict[str, dict[str, set[int]]] = {}   # 学科目录 -> 卷名 -> 题号
    try:
        with conn.cursor() as cur:
            for f in files:
                rows = _read_jsonl(f)
                todo = []
                for r in rows:
                    if args.force or not r.get("applied"):
                        todo.append(r)
                        continue
                    reason = _replay_reason(cur, r)
                    if reason:
                        # 标了已入库但库里已不是人工确认的状态：自动重放
                        print(f"[replay] {r['source'][:26]} 题{r['group_order']}："
                              f"{reason}，按补题记录重新写入", flush=True)
                        todo.append(r)
                if args.subject:
                    todo = [r for r in todo if Path(r["rel_path"]).parts[0] == args.subject]
                if args.source:
                    todo = [r for r in todo if args.source in r["source"]]
                for rec in todo:
                    msg = apply_record(cur, rec, args.apply)
                    print(f"[{rec['source'][:26]}] 题{rec['group_order']}: {msg}",
                          flush=True)
                    if not args.apply:
                        previewed += 1
                        continue
                    if msg.startswith("跳过"):
                        # 补录内容本身不合法：提交后把它退回待处理，下次扫描/补题还会提醒
                        rejected_keys.append((rec["source"], rec["group_order"], str(f)))
                        continue
                    rec["applied"] = True
                    rec["applied_at"] = datetime.now().isoformat(timespec="seconds")
                    total += 1
                    applied_keys.append((rec["source"], rec["group_order"], str(f)))
                    subject_cn = Path(rec["rel_path"]).parts[0]
                    applied_sources.setdefault(subject_cn, {}).setdefault(
                        rec["source"], set()).add(int(rec["group_order"]))
                if args.apply:
                    _write_jsonl(f, rows)
        if args.apply:
            conn.commit()
            # 状态回写在事务提交之后：写库失败时清单不能被误标成已解决
            for source, go, f in applied_keys:
                mark_issue(source, go, "resolved", note="已写入题库", fix_file=f)
            for source, go, _ in rejected_keys:
                mark_issue(source, go, "pending", note="补录内容被拒（疑似界面文字），请重新补录")
            print(f"\n[ok] 已写入 {total} 题", flush=True)
            _rescan(applied_sources)
        else:
            conn.rollback()
            if via_pipeline:
                print(f"\n[预览] 共 {previewed} 条，均未写库", flush=True)
            else:
                print(f"\n[dry-run] 预览 {previewed} 条；确认后加 --apply", flush=True)
    finally:
        conn.close()
    return 0


def main(argv=None) -> int:
    return run(argv)


if __name__ == "__main__":
    raise SystemExit(main())
