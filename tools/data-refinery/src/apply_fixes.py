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
from review_queue import mark_issue  # noqa: E402
from scope_filter import match_keyword  # noqa: E402
from subject_codes import subject_code_for_parts  # noqa: E402

FIXES_DIR = ROOT / "output" / "manual_fixes"

# material_url 三态：字段不存在 = 保持库里现状（兼容旧记录）；显式 None = 人工确认
# 本题无材料（写 NULL）；字符串 = 写入该 URL。题号/小节标题都可能在 PDF→MD 时丢失，
# 切题器判不出共享文章归属，只能由补题时人工指认，工具不猜（2026-11-21 用户裁决）。
_NO_URL_FIELD = object()

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


def _paper_scope_of(rec: dict) -> str:
    from chinese_material_doc import paper_scope_for
    return paper_scope_for(rec.get("rel_path", ""), rec.get("source", ""))


def _read_doc_body(output_dir: Path, url: str | None) -> str | None:
    """读 material_url 指向的文档正文；缺文件返回 None，不抛。"""
    if not url:
        return None
    try:
        return (Path(output_dir) / "assets" / url).read_text(encoding="utf-8")
    except OSError:
        return None


def _looks_like_article(text: str | None) -> bool:
    """粗判一段文字像不像「文章」（而非题内小素材）。"""
    t = (text or "").strip()
    if not t:
        return False
    from chinese_material_doc import material_group_reason
    if material_group_reason(t) is not None:
        return False
    has_title = bool(re.search(r"(?m)^\s*#{1,6}\s", t))
    cjk = len(re.findall(r"[\u4e00-\u9fff]", t))
    return cjk >= 100 or (has_title and cjk >= 40)


def _patch_extracted(rec: dict, *, content: str, answer: str,
                     material_text, options, output_dir: Path,
                     post_material_text: str | None = None,
                     preserve_existing_material: bool = False,
                     drop_post_material: bool = False) -> None:
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
    sub_no = int(rec.get("sub_no") or 0)

    def _same_number(r: dict) -> bool:
        return (int(r.get("group_order") or -1) == go
                and int(r.get("sub_no") or 0) == sub_no)

    pos = next((i for i, r in enumerate(rows) if _same_number(r)), None)
    existing = rows[pos] if pos is not None else None
    # 题型/难度以原行为准：无选项不等于简答题——填空/计算/证明题同样没有选项，
    # 补内容时若按「有选项=choice、否则 short_answer」重算，会把填空题降级
    # （2026-11-19 北师大实验第 14 题：补图后变 short_answer，被扫描报题型不一致）。
    payload = {
        "group_order": go,
        "sub_no": sub_no,
        "type": rec.get("expected_type") or (
            "choice" if options else (existing or {}).get("type") or "short_answer"),
        "difficulty": (existing or {}).get("difficulty") or 2,
        "content": content,
        "options": options,
        "answer": answer,
        "material_text": ((existing or {}).get("material_text")
                          if preserve_existing_material else material_text),
        "needs_review": False,
    }
    # 文章已外置的共存题：extracted 里的 material_text 是文章原文（publish 要据此
    # 外置），不能被题内素材覆盖；题内素材走 _post_material_text 通道。
    if post_material_text:
        payload["_post_material_text"] = post_material_text
    if pos is None:
        pos = next((i for i, r in enumerate(rows)
                    if (int(r.get("group_order") or 0), int(r.get("sub_no") or 0))
                    > (go, sub_no)), len(rows))
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
        if drop_post_material:
            # 与文档重复的题内素材已被判脏清空，extracted 里的 _post 也要一并清掉，
            # 否则下次 publish 又把这段重复文本注回去。
            rows[pos].pop("_post_material_text", None)

    path.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )
    # 让 publish 下次重发这份卷（否则 checkpoint 会跳过，published 还是旧题号）
    checkpoint = RefineryCheckpoint(output_dir / ".publish_checkpoint.json")
    checkpoint.load()
    checkpoint.unmark_published(f"{rel}/{src}")
    print(f"[INFO] 已回写 extracted 并标记重发：{path}", flush=True)


def _unmark_publish_checkpoint(rel: str, src: str, output_dir: Path) -> None:
    """只让这份卷下次重新 publish，不动 extracted（文章修正用）。"""
    checkpoint = RefineryCheckpoint(output_dir / ".publish_checkpoint.json")
    checkpoint.load()
    checkpoint.unmark_published(f"{rel}/{src}")


def _patch_extracted_answer(rec: dict, answer: str, output_dir: Path) -> None:
    """只补答案：extracted 里只改 answer，题面/选项/图片原样保留。"""
    rel, src = rec.get("rel_path"), rec.get("source")
    if not rel or not src:
        return
    path = output_dir / "extracted" / rel / f"{src}.jsonl"
    if not path.exists():
        print(f"[WARN] 找不到 extracted 产物，跳过回写：{path}", flush=True)
        return
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    go = int(rec["group_order"])
    sub_no = int(rec.get("sub_no") or 0)
    changed = False
    for row in rows:
        if (int(row.get("group_order") or -1) == go
                and int(row.get("sub_no") or 0) == sub_no):
            row["answer"] = answer
            changed = True
            break
    if not changed:
        print(f"[WARN] extracted 里没有第 {go} 题，答案未回写", flush=True)
        return
    path.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )
    checkpoint = RefineryCheckpoint(output_dir / ".publish_checkpoint.json")
    checkpoint.load()
    checkpoint.unmark_published(f"{rel}/{src}")
    print(f"[INFO] 已回写 extracted 答案并标记重发：{path}", flush=True)


def _patch_extracted_content(rec: dict, content: str, output_dir: Path) -> None:
    """只回写题干：恢复 LLM 自动修复前原文时用，选项/材料/答案一律原样保留。"""
    rel, src = rec.get("rel_path"), rec.get("source")
    if not rel or not src:
        return
    path = output_dir / "extracted" / rel / f"{src}.jsonl"
    if not path.exists():
        print(f"[WARN] 找不到 extracted 产物，跳过题干回写：{path}", flush=True)
        return
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    go = int(rec["group_order"])
    sub_no = int(rec.get("sub_no") or 0)
    changed = False
    for row in rows:
        if (int(row.get("group_order") or -1) == go
                and int(row.get("sub_no") or 0) == sub_no):
            row["content"] = content
            row["needs_review"] = False
            changed = True
            break
    if not changed:
        print(f"[WARN] extracted 里没有第 {go} 题，题干未回写", flush=True)
        return
    path.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
        encoding="utf-8",
    )
    checkpoint = RefineryCheckpoint(output_dir / ".publish_checkpoint.json")
    checkpoint.load()
    checkpoint.unmark_published(f"{rel}/{src}")
    print(f"[INFO] 已回写 extracted 题干并标记重发：{path}", flush=True)


def _go_int(value) -> int | None:
    """题号归一：补题记录可能是旧格式或被手改过，非法值不能让整批崩掉。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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


def _no_label(go: int, sub_no: int | None) -> str:
    """题号展示：26(1) / 26。"""
    return f"{go}({sub_no})" if sub_no else str(go)


def _existing_question(cur, paper_id: int, group_order: int, sub_no: int = 0) -> int | None:
    cur.execute(
        "SELECT pq.question_id FROM paper_questions pq "
        "JOIN questions q ON q.id = pq.question_id "
        "WHERE pq.paper_id=%s AND pq.group_order=%s AND q.sub_no=%s",
        (paper_id, group_order, sub_no))
    row = cur.fetchone()
    return int(row[0]) if row else None


def _orphan_question(cur, paper_id: int, source: str, group_order: int,
                     sub_no: int = 0) -> int | None:
    """同一份卷、同一题号、当前没挂在卷上的旧行（人工补的第一版 / 上一轮导入的残行）。

    为什么要找它：题号已经存在于库、只是关联被重导摘掉了。这时必须**更新那一行**，
    再 INSERT 就会在同一份卷里出现两道 18 题（2026-11-01 人大附实测：6338/6340/6341
    就是这样变成孤儿的）。「内容变了」不是新建的理由 —— 卷内题号就是这道题的身份。
    """
    cur.execute(
        "SELECT q.id FROM questions q "
        "WHERE q.source=%s AND q.group_order=%s AND q.sub_no=%s "
        "  AND NOT EXISTS (SELECT 1 FROM paper_questions pq WHERE pq.question_id=q.id) "
        "ORDER BY q.id LIMIT 1",
        (source, group_order, sub_no))
    row = cur.fetchone()
    return int(row[0]) if row else None


def _duplicate_numbers(cur, paper_id: int) -> list[int]:
    """同一份卷里挂了两个以上 question_no 的题号（组卷会出现同号题，必须为 0）。

    小问共用卷面题号是合法的，按 (question_no, sub_no) 判重。
    """
    cur.execute(
        "SELECT pq.question_no FROM paper_questions pq "
        "JOIN questions q ON q.id = pq.question_id "
        "WHERE pq.paper_id=%s "
        "GROUP BY pq.question_no, q.sub_no HAVING COUNT(*) > 1 "
        "ORDER BY pq.question_no",
        (paper_id,))
    return [int(r[0]) for r in cur.fetchall()]


def _renumber(cur, paper_id: int) -> int:
    """按卷面题号重排 question_no，返回受影响行数。

    与 db_loader 同一口径：`question_no = COALESCE(group_order, 行序)`，
    所以补回缺题后题号会对上（而不是把空缺挤掉、整卷顺序错位）。
    """
    cur.execute(
        "UPDATE paper_questions pq "
                    "JOIN questions q ON q.id = pq.question_id "
                    "JOIN ("
        "  SELECT pq2.question_id, "
        "         ROW_NUMBER() OVER (ORDER BY q2.group_order, q2.sub_no, pq2.question_no) rn"
        "  FROM paper_questions pq2 JOIN questions q2 ON q2.id = pq2.question_id"
        "  WHERE pq2.paper_id=%s) t"
        " ON t.question_id = pq.question_id "
        "SET pq.question_no = COALESCE(q.group_order, t.rn) "
        "WHERE pq.paper_id=%s",
        (paper_id, paper_id))
    return cur.rowcount


def pending_records(subject: str | None = None, source: str | None = None,
                    *, sources: set[str] | None = None,
                    fixes_dir: Path | None = None) -> list[dict]:
    """还没写进库的补题记录（applied!=True），可按学科 / 卷名子串收窄。"""
    out: list[dict] = []
    for f in sorted(Path(fixes_dir or FIXES_DIR).glob("*.jsonl")):
        for rec in _read_jsonl(f):
            if rec.get("applied"):
                continue
            if subject and Path(rec.get("rel_path", "")).parts[:1] != (subject,):
                continue
            if sources is not None and rec.get("source") not in sources:
                continue
            if source and not match_keyword(rec.get("source", ""), source):
                continue
            rec["_file"] = str(f)
            out.append(rec)
    return out


def needing_replay(subject: str | None = None, source: str | None = None,
                   *, sources: set[str] | None = None,
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
            if sources is not None and rec.get("source") not in sources:
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


def _unmark_publish_for_source(src: str, output_dir: Path) -> None:
    """按卷名找 extracted 里的相对路径，清掉该卷的 publish checkpoint。"""
    extracted = output_dir / "extracted"
    if not extracted.exists():
        return
    for path in extracted.rglob(f"{src}.jsonl"):
        rel = path.relative_to(extracted).with_suffix("")
        _unmark_publish_checkpoint(str(rel.parent), src, output_dir)


def _log_hash_conflict(output_dir: Path, qid: int) -> None:
    path = output_dir / "content_hash_conflicts.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"question_id": qid, "reason": "article_url_change",
                             "ts": datetime.now().isoformat(timespec="seconds")},
                            ensure_ascii=False) + "\n")


def _sync_applied_hashes(hash_map: dict, output_dir: Path,
                         *, source: str | None = None) -> None:
    """兄弟题 URL 变了 → applied_hash 也要跟着换，否则 needing_replay 每次都误报。

    按 source 过滤：卷内 key 后不同卷的同一段内容各有 URL，不能串着改。
    """
    from review_queue import _read_jsonl, _write_jsonl

    for f in (output_dir / "manual_fixes").glob("*.jsonl"):
        rows = _read_jsonl(f)
        changed = False
        for row in rows:
            if source and row.get("source") and row.get("source") != source:
                continue
            old = row.get("applied_hash")
            if old in hash_map:
                row["applied_hash"] = hash_map[old]
                changed = True
        if changed:
            _write_jsonl(f, rows)


def _sync_extracted_article(rec: dict, new_body: str, old_body: str | None,
                            output_dir: Path) -> None:
    """同卷 extracted 里同一篇文章的正文一起改。

    publish 是按 extracted 的 material_text **分组**外置的：只改一道题，同一篇文
    会被拆成两组（新旧正文各一组），谁后写谁覆盖 content.md。把同组的正文同步成
    新正文后，publish 只会有一组、一个 URL（2026-11-22 Q21 实测）。
    """
    from chinese_material_doc import same_article
    from review_queue import _read_jsonl, _write_jsonl

    rel, src = rec.get("rel_path"), rec.get("source")
    if not rel or not src:
        return
    path = Path(output_dir) / "extracted" / rel / f"{src}.jsonl"
    if not path.exists():
        return
    rows = _read_jsonl(path)
    changed = False
    for row in rows:
        text = (row.get("material_text") or "").strip()
        if text and (same_article(text, new_body)
                     or (old_body and same_article(text, old_body))):
            if row.get("material_text") != new_body:
                row["material_text"] = new_body
                changed = True
        post = (row.get("_post_material_text") or "").strip()
        if post and same_article(post, new_body):
            row.pop("_post_material_text", None)
            changed = True
    if changed:
        _write_jsonl(path, rows)


def _sync_extracted_article_groups(rec: dict, new_body: str,
                                   groups: set[int], output_dir: Path) -> None:
    """新建共享文章：把正文写进共用题号的 extracted，保证 publish 只外置一组。

    这些题原本没有文章（PDF→MD 丢了），material_text 可能是题内素材：不能覆盖，
    挪到 ``_post_material_text``（题后素材通道），publish 会再注回 material_text。
    """
    from chinese_material_doc import same_article
    from review_queue import _read_jsonl, _write_jsonl

    rel, src = rec.get("rel_path"), rec.get("source")
    if not rel or not src:
        return
    path = Path(output_dir) / "extracted" / rel / f"{src}.jsonl"
    if not path.exists():
        return
    rows = _read_jsonl(path)
    changed = False
    for row in rows:
        if row.get("group_order") not in groups:
            continue
        text = (row.get("material_text") or "").strip()
        if text and not same_article(text, new_body):
            row.setdefault("_post_material_text", text)
        if row.get("material_text") != new_body:
            row["material_text"] = new_body
            changed = True
    if changed:
        _write_jsonl(path, rows)


def _create_article_doc(cur, rec, body: str, output_dir: Path, *,
                        paper_id: int, paper_scope: str) -> tuple[str, str]:
    """给「原本没有文章」的题新建共享文章，并挂到本题 + 人工指定的共用题号。

    与 ``_correct_article_doc`` 的区别：没有 old_url，doc_key 直接按
    试卷 + 正文算（算法不变）；publish 不写库，所以 material_url / content_hash
    必须在这里直接落库，否则页面读不到。
    """
    from chinese_material_doc import same_article, write_material_doc
    from image_rewrite import _resolve_src

    assets_dir = output_dir / "assets"
    md_images_dir = output_dir / "md" / Path(rec.get("rel_path", ""))
    resolver = lambda ref: _resolve_src(ref, md_images_dir)
    store = LocalAssetStore(assets_dir)
    kwargs = dict(resolver=resolver, store=store, assets_dir=assets_dir,
                  subject_code="chinese")
    key, url = write_material_doc(body, dry_run=False,
                                  paper_scope=paper_scope, **kwargs)

    groups = {int(rec["group_order"])}
    for g in rec.get("material_share_with") or []:
        try:
            groups.add(int(g))
        except (TypeError, ValueError):
            continue

    cur.execute(
        "SELECT pq.group_order, q.id, q.content, q.options, q.content_hash, "
        "q.material_text, q.material_url "
        "FROM paper_questions pq JOIN questions q ON q.id=pq.question_id "
        "WHERE pq.paper_id=%s", (paper_id,))
    rows = {int(go): (qid, content, opts, old_hash, text, old_url)
            for go, qid, content, opts, old_hash, text, old_url in cur.fetchall()}
    missing = sorted(g for g in groups if g not in rows)
    targets = []
    for go in sorted(groups):
        if go not in rows:
            continue
        qid, content, opts, old_hash, text, old_url = rows[go]
        if old_url and old_url != url:
            print(f"[WARN] 第{go}题已有别的文章（{old_url}），未改挂到新文章", flush=True)
            continue
        # 旧 material_text 若就是这篇文章（URL 丢了但正文还在），不能当题内素材留库
        keep = text if text and not same_article(text, body) else None
        targets.append((go, qid, content, opts, old_hash, keep))

    stamp = hashlib.sha256(datetime.now().isoformat().encode()).hexdigest()[:12]
    hash_map: dict = {}
    for idx, (_go, qid, *_rest) in enumerate(targets):
        cur.execute("UPDATE questions SET content_hash=%s WHERE id=%s",
                    (f"_tmp_{stamp}_{idx}", qid))
    for _go, qid, content, opts_json, old_hash, text in targets:
        try:
            opts = json.loads(opts_json) if opts_json else None
        except (TypeError, ValueError):
            opts = None
        final = content_hash(content or "", opts, text or None, url)
        try:
            cur.execute("UPDATE questions SET material_url=%s, material_text=%s, "
                        "content_hash=%s WHERE id=%s", (url, text or None, final, qid))
        except Exception:  # noqa: BLE001 - 哈希撞车不能拖垮整批
            cur.execute("UPDATE questions SET material_url=%s, material_text=%s "
                        "WHERE id=%s", (url, text or None, qid))
            final = old_hash
            _log_hash_conflict(output_dir, qid)
        hash_map[old_hash] = final

    _sync_extracted_article_groups(rec, body, {go for go, *_ in targets}, output_dir)
    _sync_applied_hashes(hash_map, output_dir, source=rec.get("source"))
    _unmark_publish_for_source(rec.get("source", ""), output_dir)
    note = f"新建共享文章 {key}，挂到 {len(targets)} 题"
    if missing:
        note += f"（第 {'、'.join(map(str, missing))} 题不在此卷，已跳过）"
    return url, note


def _correct_article_doc(cur, rec, material_text: str, old_url: str,
                         output_dir: Path, *, paper_id: int | None = None,
                         paper_scope: str | None = None) -> tuple[str, str]:
    """人工校对共享文章：按规范化参数重算 doc_key，写文档并同步**同卷**兄弟题。

    返回 (最终 material_url, 结果说明)。key 不变时原地改 content.md、URL/hash 不动；
    key 变了就写新文档、把**同一份卷**里共用旧 URL 的题改到新 URL 并重算 hash。
    卷维度让同一段内容在不同试卷各自成文件、互不影响（旧文档不删）。
    """
    from chinese_material_doc import write_material_doc
    from image_rewrite import _resolve_src
    from review_queue import _read_jsonl, _write_jsonl

    assets_dir = output_dir / "assets"
    md_images_dir = output_dir / "md" / Path(rec.get("rel_path", ""))
    resolver = lambda ref: _resolve_src(ref, md_images_dir)
    store = LocalAssetStore(assets_dir)
    kwargs = dict(resolver=resolver, store=store, assets_dir=assets_dir,
                  subject_code="chinese")
    paper_scope = paper_scope if paper_scope is not None else _paper_scope_of(rec)
    new_key, new_url = write_material_doc(
        material_text, dry_run=True, paper_scope=paper_scope, **kwargs)
    old_key = Path(old_url).parent.name

    # 先读旧正文：key 不变时下面会原地覆盖 content.md，覆盖后就比不出来了。
    from chinese_material_doc import same_article

    old_body = _read_doc_body(output_dir, old_url)

    # 无论 key 是否变化都要落盘：key 不变时是原地覆盖同一个 content.md。
    write_material_doc(material_text, dry_run=False, paper_scope=paper_scope, **kwargs)

    # 兄弟题要按**文章内容**认，不能只按旧 URL 认：URL 可能已经在之前的
    # 卷内 key 迁移中分叉（同一篇文，20/22/23 一个文件、21 另一个文件），
    # 只按 URL 匹配会漏掉它们（2026-11-22 Q21 实测）。
    if paper_id is not None:
        cur.execute(
            "SELECT q.id, q.source, q.content, q.options, q.content_hash, q.material_url "
            "FROM questions q JOIN paper_questions pq ON pq.question_id=q.id "
            "WHERE pq.paper_id=%s", (paper_id,))
        rows = []
        for qid, source, content, opts_json, old_hash, url in cur.fetchall():
            body = _read_doc_body(output_dir, url)
            if url == old_url or (body and same_article(body, material_text)):
                rows.append((qid, source, content, opts_json, old_hash, url))
    else:
        cur.execute(
            "SELECT id, source, content, options, content_hash FROM questions "
            "WHERE material_url=%s", (old_url,))
        rows = [(qid, source, content, opts_json, old_hash, old_url)
                for qid, source, content, opts_json, old_hash in cur.fetchall()]

    stamp = hashlib.sha256(datetime.now().isoformat().encode()).hexdigest()[:12]
    hash_map: dict = {}
    changed = 0
    for idx, (qid, source, content, opts_json, old_hash, url) in enumerate(rows):
        if new_key == old_key and url == new_url:
            continue                      # 原地改文，URL/hash 都不动
        # 两阶段更新，避开 UNIQUE(content_hash) 在批量换 URL 时的中间态冲突
        cur.execute("UPDATE questions SET content_hash=%s WHERE id=%s",
                    (f"_tmp_{stamp}_{idx}", qid))
        try:
            opts = json.loads(opts_json) if opts_json else None
        except (TypeError, ValueError):
            opts = None
        final = content_hash(content or "", opts, None, new_url)
        try:
            cur.execute("UPDATE questions SET material_url=%s, content_hash=%s "
                        "WHERE id=%s", (new_url, final, qid))
            hash_map[old_hash] = final
        except Exception:
            cur.execute("UPDATE questions SET material_url=%s WHERE id=%s",
                        (new_url, qid))
            hash_map[old_hash] = old_hash
            _log_hash_conflict(output_dir, qid)
        changed += 1
        if source:
            _unmark_publish_for_source(source, output_dir)
    _sync_applied_hashes(hash_map, output_dir, source=rec.get("source"))
    _sync_extracted_article(rec, material_text, old_body, output_dir)
    if new_key == old_key:
        note = (f"文章 doc_key 不变（{old_key}），已原地重写 content.md"
                + (f"；并把 {changed} 道分叉到别的文档的同卷题并回本篇" if changed else ""))
    else:
        note = f"文章 doc_key {old_key}→{new_key}，已同步 {changed} 道同卷题"

    # publish 下次仍要从 extracted 读文章；override 保证修正不会被冲掉。
    # 匹配只按 old_key（跨卷兄弟题也要命中），source 仅作溯源。
    path = output_dir / "material_doc_overrides.jsonl"
    overrides = [r for r in _read_jsonl(path) if r.get("old_key") != old_key] \
        if path.exists() else []
    overrides.append({
        "old_key": old_key, "new_key": new_key, "body": material_text,
        "provenance_source": rec.get("source"),
        "created_at": datetime.now().isoformat(timespec="seconds"),
    })
    _write_jsonl(path, overrides)
    _unmark_publish_for_source(rec.get("source", ""), output_dir)
    return new_url, note


def apply_record(cur, rec: dict, apply: bool, *, assets_root: Path | None = None,
                 output_dir: Path | None = None) -> str:
    from review_editor import looks_like_ui_echo, looks_like_wrapped_copy

    if looks_like_ui_echo(rec.get("content") or ""):
        return "跳过：内容疑似终端界面文字（不是真题），请重新补录"
    for field in ("content", "material_text", "material_inline_text"):
        if looks_like_wrapped_copy(rec.get(field) or ""):
            return ("跳过：材料带终端折行痕迹（行首 │ / 标签被换行截断），"
                    "请从原卷 md 或网页正文复制后重新录入")
    found = _paper_row(cur, rec["rel_path"], rec["source"])
    if not found:
        return "跳过：库里没有这份卷（先跑 import_cli 入库）"
    paper_id, subject_id = found
    go = int(rec["group_order"])
    sub_no = int(rec.get("sub_no") or 0)
    qid = _existing_question(cur, paper_id, go, sub_no)
    orphan = False
    if qid is None:
        # 题号在库、只是关联被摘掉（重导/旧版补题）：更新那一行，别新建同号题
        qid = _orphan_question(cur, paper_id, rec.get("source", ""), go, sub_no)
        orphan = qid is not None
    if qid is None and not sub_no:
        # 同号多小问时，没有 sub_no 的旧记录无法确定目标：宁可拒写，不能写到另一个小问
        cur.execute(
            "SELECT COUNT(*) FROM paper_questions pq "
            "JOIN questions q ON q.id = pq.question_id "
            "WHERE pq.paper_id=%s AND pq.group_order=%s", (paper_id, go))
        if int(cur.fetchone()[0]) > 1:
            return f"跳过：第{go}题有多个小问，记录缺少 sub_no，无法确定写哪一条"

    # 只补答案：不碰题面/材料，必须放在材料归属护栏之前。旧版 answer_only 记录
    # 曾复制 material_text，若先过护栏会被误拦（2026-11-21 实测缺口）。
    if rec.get("answer_only"):
        answer = (rec.get("answer") or "").strip()
        if not apply:
            return (f"只补答案：paper={paper_id} 第{_no_label(go, sub_no)}题"
                    f"（question_id={qid or '—'}）· 题面不动")
        if qid is None:
            return "跳过：题库里找不到这道题，无法只补答案"
        if not answer and not rec.get("clear_answer"):
            return "跳过：答案为空"
        if rec.get("clear_answer"):
            answer = ""              # 显式清空：绕过上面的空值拒绝
        cur.execute("UPDATE questions SET answer=%s WHERE id=%s", (answer, qid))
        _patch_extracted_answer(
            rec, answer, output_dir or RefineryConfig.from_env().output_dir,
        )
        return f"更新答案：paper={paper_id} 第{_no_label(go, sub_no)}题 -> question_id={qid}"

    # ---- 材料路由：按「内容实际存在哪」写入正确位置，不再让人选存储通道 ----
    # 语文材料有两种载位：外置文章（material_url）与题内素材（material_text）。
    # 人工只改内容，这里按目标自动分流；article 走 _correct_article_doc
    # （重算 key/url、同步同卷、清 text），inline 写 material_text。
    explicit_url = rec.get("material_url", _NO_URL_FIELD)
    target_url = None
    existing_options = None
    existing_text = None
    if qid:
        cur.execute(
            "SELECT material_url, options, material_text "
            "FROM questions WHERE id=%s", (qid,))
        row = cur.fetchone()
        if row:
            target_url, existing_options = row[0], row[1]
            existing_text = row[2] or ""
    out_dir = output_dir or RefineryConfig.from_env().output_dir
    chinese = subject_code_for_parts(Path(rec["rel_path"]).parts, default="") == "chinese"

    # 只恢复题干：丢弃 LLM 自动修复的砍短结果、把修复前原文写回去。
    # 选项/材料/答案一律不碰，避免把题内素材或外置文章冲掉（2026-11-23）。
    if rec.get("content_only"):
        content = (rec.get("content") or "").strip()
        if not content:
            return "跳过：恢复的题干为空"
        if qid is None:
            return "跳过：题库里找不到这道题，无法恢复原文"
        chash = content_hash(content, existing_options, existing_text, target_url)
        if not apply:
            return (f"恢复原文：paper={paper_id} 第{_no_label(go, sub_no)}题"
                    f"（question_id={qid}）· {len(content)} 字；选项/材料/答案不动")
        cur.execute(
            "UPDATE questions SET content=%s, content_hash=%s, is_active=1, "
            "needs_review=0 WHERE id=%s", (content, chash, qid))
        _patch_extracted_content(rec, content, out_dir)
        return f"已恢复原文：paper={paper_id} 第{_no_label(go, sub_no)}题（question_id={qid}）"

    # 没有挂到卷上时，可能是「新增」，也可能是「复用」一条同内容的遗留行（重导摘了关联、
    # 没删题）。真正的选择要等内容物化后算哈希才知道，预览先把这个可能说清楚。
    action = "更新" if qid else "新增（同内容已存在则复用）"

    url_note = ""
    if explicit_url is not _NO_URL_FIELD:
        if isinstance(explicit_url, str) and explicit_url.strip():
            url_note = (f" · material_url: {target_url or '无'} → "
                        f"{explicit_url.strip()}")
        else:
            url_note = f" · material_url: {target_url or '无'} → 无（确认无材料）"

    if not apply:
        # 预览要能判断"内容对不对"，只报更新/新增没用（用户 2026-10-31 指出）
        detail = (f"{action}：paper={paper_id} 第{_no_label(go, sub_no)}题（question_id={qid or '—'}）"
                  f" · 新内容 {len(rec.get('content') or '')} 字{url_note}")
        if qid:
            cur.execute("SELECT CHAR_LENGTH(content) FROM questions WHERE id=%s", (qid,))
            row = cur.fetchone()
            if row and row[0] is not None:
                detail += f"（原来 {int(row[0])} 字）"
        snippet = (rec.get("content") or "").replace("\n", " ")[:36]
        return f"{detail}\n        内容：{snippet}…"

    content = rec["content"]
    answer = rec.get("answer") or ""
    # 物化图片会原地改写 options 的 dict/text/image_url。用副本，别污染补题记录：
    # 回写 manual_fixes 时 rec 会被整条写回，否则记录里会混入库侧规范路径。
    options = copy.deepcopy(rec.get("options"))
    forced_type = rec.get("expected_type") or None

    # 只改题干时粘贴内容里没有 A/B/C/D，补题记录的 options 是 None；直接写库会把
    # 原题已有选项整列抹掉（用户 2026-11-21 报的「选项符被吞掉」）。没有新选项
    # 就沿用原选项；确实要清空需显式给空列表。
    if options is None and existing_options:
        try:
            parsed = (json.loads(existing_options)
                      if isinstance(existing_options, str) else existing_options)
            if isinstance(parsed, list) and parsed:
                options = parsed
                print(f"[INFO] 第{go}题补题未带选项，保留原题已有的 "
                      f"{'/'.join(str(o.get('label') or '?') for o in options)}", flush=True)
        except (TypeError, ValueError):
            pass

    # ---- 应用路由结果 ----
    record_target = _record_target(rec)
    article_rec = (rec.get("material_text") or "").strip()
    inline_rec = (rec.get("material_inline_text") or "").strip()
    article_note = ""
    new_url = target_url
    material_text = existing_text or None
    extracted_material = None
    extracted_post = None
    drop_post = False
    preserve_existing = False
    skip_extracted = False

    if not chinese:
        # 非语文：材料只有 material_text，沿用旧逻辑（直接写列）
        material_text = rec.get("material_text")
        # 保留旧护栏：非语文一般不外置文章；若这行已有 material_url 又带
        # material_text、且未声明归属，仍拒收，避免 url+text 串档。
        if (explicit_url is _NO_URL_FIELD and material_text
                and str(material_text).strip() and target_url
                and not rec.get("material_scope")):
            return ("跳过：材料归属未标明（该题文章已外置为 md）。"
                    "请重新校对，明确这段是题内素材还是共享文章")
        if explicit_url is not _NO_URL_FIELD:
            if isinstance(explicit_url, str) and explicit_url.strip():
                new_url = explicit_url.strip()
                if not (out_dir / "assets" / new_url).exists():
                    return f"跳过：指认的材料文档不存在（{new_url}），请确认 URL 或先重发该卷"
            else:
                new_url, material_text = None, None
        extracted_material = material_text
    else:
        from chinese_material_doc import same_article
        doc_body = _read_doc_body(out_dir, target_url)
        heal_inline = bool(target_url and existing_text and doc_body
                           and same_article(existing_text, doc_body))

        if explicit_url is not _NO_URL_FIELD:
            # 人工指认 URL（写/清 URL 列），不重写文档
            if (record_target == "article" and article_rec
                    and isinstance(explicit_url, str) and explicit_url.strip()):
                return "跳过：指认 URL 与改文章正文不能同时进行，请分开处理"
            if explicit_url is None:
                new_url, material_text = None, None
                drop_post = True
            else:
                cu = (explicit_url.strip()
                      if isinstance(explicit_url, str) and explicit_url.strip() else None)
                if cu and not (out_dir / "assets" / cu).exists():
                    return f"跳过：指认的材料文档不存在（{cu}），请确认 URL 或先重发该卷"
                new_url = cu
                if article_rec:            # URL + 题内素材（认领 + 补充）
                    material_text = article_rec
                    extracted_post = article_rec
                    preserve_existing = bool(cu)
                else:                      # 仅认领/沿用 URL
                    material_text = existing_text or None
                    preserve_existing = bool(cu)
        else:
            if not record_target and article_rec:
                # 记录没标目标 → 按内容推断
                if target_url and doc_body and same_article(article_rec, doc_body):
                    record_target = "article"
                elif target_url and existing_text and not same_article(existing_text, doc_body):
                    record_target = "inline"
                elif target_url:
                    record_target = "article" if _looks_like_article(article_rec) else "inline"
                else:
                    record_target = "article" if _looks_like_article(article_rec) else "inline"

            if article_rec and target_url and doc_body and same_article(article_rec, doc_body):
                # 目标写 inline、但内容其实是文档同段（Q5 类）→ 按文章修
                if record_target in (None, "inline"):
                    record_target = "article"
                heal_inline = True

            if record_target in ("article", "both") and article_rec:
                # extracted 里的文章正文必须同步成**修正后**的正文：publish 是
                # 按 extracted 外置的，若这里还留着旧文，下次重发会用旧文覆盖
                # 刚写好的 content.md（2026-11-22 Q21 实测）。
                extracted_material = article_rec
                if target_url:
                    new_url, article_note = _correct_article_doc(
                        cur, rec, article_rec, target_url, out_dir,
                        paper_id=paper_id, paper_scope=_paper_scope_of(rec))
                else:
                    # 原题没有文章：新建，并把 material_url/哈希直接写库
                    # （publish 只写文档和 published，不回写库）
                    new_url, article_note = _create_article_doc(
                        cur, rec, article_rec, out_dir, paper_id=paper_id,
                        paper_scope=_paper_scope_of(rec))
                    if existing_text and not same_article(existing_text, article_rec):
                        extracted_post = existing_text
                if record_target == "both":
                    material_text = inline_rec or None
                    extracted_post = inline_rec or None
                elif heal_inline:
                    material_text = None
                    drop_post = True
                elif target_url:
                    material_text = existing_text or None   # 保留合法题内补充
                    preserve_existing = True
                else:
                    # 新建文章：旧 material_text 若就是这篇文章（URL 丢了但正文还在），
                    # 不能当题内素材留在库里，否则文章会被重复注入。
                    keep = bool(existing_text) and not same_article(existing_text, article_rec)
                    material_text = existing_text if keep else None
                    if keep:
                        extracted_post = existing_text
            elif record_target == "inline" or (record_target is None and inline_rec):
                val = inline_rec or article_rec or None
                material_text = val
                if val and new_url:
                    extracted_post = val
                    preserve_existing = True
                else:
                    extracted_material = val
            else:
                # 无材料改动：保持 extracted 现有材料
                material_text = existing_text or None
                preserve_existing = True

        skip_extracted = bool(target_url and record_target in ("article", "both")
                              and not extracted_post and not drop_post
                              and extracted_material is None)

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
    raw_material = extracted_material if extracted_material is not None else material_text
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

    chash = content_hash(content, options, material_text, new_url)
    if skip_extracted:
        # 只改文章正文：extracted 的旧正文不能被覆盖（下次 publish 会据此再写文档），
        # 修正靠 material_doc_overrides.jsonl 生效。
        _unmark_publish_checkpoint(rec.get("rel_path", ""), rec["source"], out_dir)
    else:
        _patch_extracted(
            rec, content=raw_content, answer=raw_answer,
            material_text=raw_material, options=raw_options,
            output_dir=out_dir,
            post_material_text=extracted_post,
            preserve_existing_material=preserve_existing,
            drop_post_material=drop_post,
        )
    if qid:
        cur.execute(
            "UPDATE questions SET content=%s, options=%s, "
            "type=COALESCE(%s, IF(%s,'choice',type)), "
            "answer=COALESCE(NULLIF(%s,''), answer), material_text=%s, "
            "content_hash=%s, material_url=%s, sub_no=%s, is_active=1 WHERE id=%s",
            (content,
             json.dumps(options, ensure_ascii=False) if options else None,
             forced_type, 1 if options else 0,
             answer, material_text, chash, new_url, sub_no, qid))
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
                "answer=COALESCE(NULLIF(%s,''), answer), material_text=%s, "
                "is_active=1, material_url=%s, sub_no=%s WHERE id=%s",
                (content,
                 json.dumps(options, ensure_ascii=False) if options else None,
                 forced_type, 1 if options else 0,
                 answer, material_text, new_url, sub_no, qid))
            cur.execute(
                "INSERT IGNORE INTO paper_questions "
                "(paper_id, question_id, question_no, group_order) VALUES (%s,%s,%s,%s)",
                (paper_id, qid, go, go))
        else:
            action = "新增"
            cur.execute(
                "INSERT INTO questions (subject_id, group_order, sub_no, type, difficulty, content, options, "
                "answer, material_text, grade_band, source, source_year, "
                "content_hash, is_active, material_url) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1,%s)",
                (subject_id, go, sub_no,
                 forced_type or ("choice" if options else "short_answer"), 2,
                 content,
                 json.dumps(options, ensure_ascii=False) if options else None,
                 answer, material_text,
                 "junior", rec["source"], 2024, chash, new_url))
            qid = int(cur.lastrowid)
            cur.execute(
                "INSERT IGNORE INTO paper_questions (paper_id, question_id, question_no, group_order) "
                "VALUES (%s,%s,%s,%s)", (paper_id, qid, go, go))

    if rec.get("clear_answer") and qid:
        # answer 列是 TEXT NOT NULL：显式清空写空串。主 UPDATE 用
        # COALESCE(NULLIF(%s,''), answer) 保旧值，不额外写一条就清不掉。
        cur.execute("UPDATE questions SET answer='' WHERE id=%s", (qid,))

    _renumber(cur, paper_id)
    cur.execute("UPDATE exam_papers SET question_count=(SELECT COUNT(*) FROM paper_questions "
                "WHERE paper_id=%s) WHERE id=%s", (paper_id, paper_id))
    dup = _duplicate_numbers(cur, paper_id)
    if dup:
        print(f"[WARN] paper={paper_id} 卷内题号重复：{dup}（组卷会出现同号题，请检查）",
              flush=True)
    # 记下写入时的内容哈希：下次重导若把这道题的内容换回旧的，能立刻发现并重放
    rec["applied_hash"] = chash
    suffix = f" · {article_note}" if article_note else ""
    return f"{action}：paper={paper_id} 第{_no_label(go, sub_no)}题 -> question_id={qid}{suffix}"


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
        "WHERE pq.paper_id=%s AND pq.group_order=%s AND q.sub_no=%s",
        (found[0], go, int(rec.get("sub_no") or 0)))
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


def _publish_sources(sources: set[str] | dict[str, str]) -> None:
    """补题/材料改完后同步 published，并把 published 回灌数据库（一条命令内完成）。

    页面读的是库，apply_fixes 先把人工内容直接写库；但 publish 还会做**题后材料
    拆分**（`externalize_chinese_materials` → `split_inline_material`）、文章外置、
    页脚/小节指令清洗、图片路径改写等变换。只 publish 不回灌，库会停在变换前的
    版本：东城模拟一 Q11 的题干带着韩愈题后材料、`material_text` 为空，页面就把
    材料当题干显示（2026-11-22 实测）。所以 publish 后再用 db_loader 增量重载
    同卷，保证 **库 == published**。

    失败不回滚已提交的库，只告警（与 publish 同口径）；回灌失败时 published 已
    是正确版本，下次导入/重载会自愈。
    """
    if not sources:
        return
    from publish_cli import main as publish_main
    from db_loader_cli import main as loader_main

    print("\n[发布] 同步 published 并回灌库（改写过的卷）：", flush=True)
    for src in sorted(sources):
        exact_rel = sources.get(src) if isinstance(sources, dict) else None
        try:
            rc = publish_main(
                ["--file-exact", exact_rel] if exact_rel else ["--book", src]
            )
        except Exception as exc:            # noqa: BLE001 - 库已提交，发布失败不影响页面
            print(f"  ! {src}: publish 失败（库已写入，不影响页面）：{exc}", flush=True)
            continue
        if rc not in (None, 0):
            print(f"  ! {src}: publish 返回 {rc}，跳过回灌（库已写入）", flush=True)
            continue
        print(f"  · {src}: publish ok", flush=True)
        # 增量回灌：--load-cards 不触发 full-reload，按 (paper_id, group_order)
        # 原地更新，question id 不变（进行中的考试/作答关联不会断）。
        try:
            rc = loader_main(
                ["--load-cards", "--questions-only", "--file-exact", exact_rel]
                if exact_rel else
                ["--load-cards", "--questions-only", "--file", src]
            )
            print(f"  · {src}: 回灌 {'ok' if rc in (None, 0) else f'返回 {rc}'}", flush=True)
        except Exception as exc:            # noqa: BLE001 - published 已是正确版本
            print(f"  ! {src}: 回灌失败（published 已更新，下次导入会自愈）：{exc}", flush=True)


def run(argv=None, *, via_pipeline: bool = False) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixes-dir", default=str(FIXES_DIR))
    parser.add_argument("--subject", help="学科中文名过滤（按 rel_path 首段）")
    parser.add_argument("--source", help="卷名子串过滤（如 一零一中学）")
    parser.add_argument("--source-exact", help="精确卷名过滤（import_cli 已解析单卷时内部使用）")
    parser.add_argument("--apply", action="store_true", help="真正写库（默认只预览）")
    parser.add_argument("--dry-run", action="store_true", help="只预览（与默认行为一致，便于显式声明）")
    parser.add_argument("--force", action="store_true", help="连 applied=true 的记录也重放")
    parser.add_argument("--group-order", type=int,
                        help="只处理指定卷面题号的补题记录（避免误写同卷其它 pending 题）")
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
    applied_keys: list[tuple[str, int, int, str]] = []
    rejected_keys: list[tuple[str, int | None, str, str]] = []
    applied_sources: dict[str, dict[str, set[int]]] = {}   # 学科目录 -> 卷名 -> 题号
    material_sources: dict[str, str] = {}                  # 卷名 → rel_path，需精确重发
    # 补题文件的 applied 标记必须在事务提交**之后**落盘。否则同一批里后面的记录
    # 抛异常 → conn.rollback()，但前面文件已写成 applied=True，库里却没写，
    # needing_replay 又认不出，题就永久丢了（2026-11-21 实测复现）。
    written_files: list[tuple[Path, list[dict]]] = []
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
                if args.source_exact:
                    todo = [r for r in todo if r["source"] == args.source_exact]
                if args.group_order is not None:
                    todo = [r for r in todo
                            if _go_int(r.get("group_order")) == args.group_order]
                for rec in todo:
                    go = _go_int(rec.get("group_order"))
                    if go is None:
                        msg = f"跳过：题号非法（{rec.get('group_order')!r}），请重新补录"
                        print(f"[{str(rec.get('source'))[:26]}] 题?: {msg}", flush=True)
                        rejected_keys.append((str(rec.get("source", "?")),
                                              rec.get("group_order"),
                                              _go_int(rec.get("sub_no")) or 0,
                                              str(f), msg))
                        continue
                    # 每条记录一个 savepoint：单条异常/拒绝只回滚它自己，其它题照常入库。
                    # 否则一条坏记录会让整批回滚，好题也跟着丢（2026-11-21 实测）。
                    if args.apply:
                        cur.execute("SAVEPOINT apply_fix_record")
                    try:
                        msg = apply_record(cur, rec, args.apply)
                    except Exception as exc:  # noqa: BLE001 - 单条失败不能拖垮整批
                        if args.apply:
                            cur.execute("ROLLBACK TO SAVEPOINT apply_fix_record")
                            cur.execute("RELEASE SAVEPOINT apply_fix_record")
                        msg = f"跳过：处理异常（{type(exc).__name__}: {exc}）"
                    print(f"[{str(rec.get('source'))[:26]}] 题{go}: {msg}", flush=True)
                    if not args.apply:
                        previewed += 1
                        continue
                    if msg.startswith("跳过"):
                        # 补录内容本身不合法：撤销本条已做的部分写，退回待处理
                        cur.execute("ROLLBACK TO SAVEPOINT apply_fix_record")
                        cur.execute("RELEASE SAVEPOINT apply_fix_record")
                        rejected_keys.append((rec["source"], rec["group_order"],
                                              _go_int(rec.get("sub_no")) or 0,
                                              str(f), msg))
                        continue
                    cur.execute("RELEASE SAVEPOINT apply_fix_record")
                    rec["applied"] = True
                    rec["applied_at"] = datetime.now().isoformat(timespec="seconds")
                    total += 1
                    applied_keys.append((rec["source"], go,
                                         _go_int(rec.get("sub_no")) or 0, str(f)))
                    if (rec.get("material_target") or rec.get("material_scope")
                            or "material_url" in rec
                            or (rec.get("material_text") or "").strip()):
                        material_sources[rec["source"]] = rec.get("rel_path", "")
                    subject_cn = Path(rec["rel_path"]).parts[0]
                    applied_sources.setdefault(subject_cn, {}).setdefault(
                        rec["source"], set()).add(go)
                if args.apply and rows:
                    written_files.append((f, rows))
        if args.apply:
            conn.commit()
            # 提交成功后才落 applied 标记；提交失败/中途异常时全部保持待写状态
            for f, rows in written_files:
                _write_jsonl(f, rows)
            # 状态回写在事务提交之后：写库失败时清单不能被误标成已解决
            for source, go, sub_no, f in applied_keys:
                mark_issue(source, go, "resolved", note="已写入题库", fix_file=f,
                           sub_no=sub_no, statuses={"pending", "recorded"})
            for source, go, sub_no, f, reason in rejected_keys:
                mark_issue(source, go, "pending", note=f"补录内容被拒：{reason}",
                           fix_file=f, sub_no=sub_no,
                           statuses={"pending", "recorded"})
            print(f"\n[ok] 已写入 {total} 题", flush=True)
            _rescan(applied_sources)
            _publish_sources(material_sources)
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
