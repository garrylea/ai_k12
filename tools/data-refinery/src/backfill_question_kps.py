"""一次性回填：用 LLM 给题库每题标 1-3 个知识点（question_knowledge_points，role='primary'）。

流程（main，镜像 backfill_practice_questions.py）：
1. 加载 KP 白名单（knowledge_points，按 --subject 的学科过滤；默认 math）。
2. SELECT 未标注的本学科题（LEFT JOIN question_knowledge_points qkp ... IS NULL，
   且 q.subject_id 与白名单学科一致——库中含他科题，不限定会把本科
   KP 错标到他科题上）——幂等，已有 qkp 记录的题不再处理。
3. 每批 10 题调 LLM（prompt 附白名单 id+name 清单 + 每题 qid/题面截断 500 字），
   要求输出 {"items": [{"qid": 123, "kps": [1, 17]}]}，按 qid 对回每题
   （LLM 漏答/输出非法的题记失败，可重跑补齐）。提示词按学科取自
   `prompts/question_kps/<subject>.txt`（公共契约在 `_common.txt`）。
4. 白名单校验（parse_batch_response 内过滤）后 INSERT IGNORE 写入
   （question_knowledge_points 有 uniq_qkp_q_kp 唯一键，重复执行不插重）。
5. 打印统计：标注数 / 失败题 id 清单。

纯函数（可测，LLM 不参与）：parse_kp_response / parse_batch_response /
build_question_select_sql / build_question_block / build_user_message / _filter_kps。
LLM 与 DB 只出现在 main。

英语阅读/完形题的题干常为空、文章在 material_url（题内材料在 material_text），
默认只读 content/options 会把文章题标错。两个开关（默认关，其它学科行为不变）：
    --include-material  读 material_text + material_url 正文随题送模型
    --answerable-only   只标注在架且有标准答案的题

用法：cd tools/data-refinery
    python src/backfill_question_kps.py                  # 数学（默认）
    python src/backfill_question_kps.py --subject chinese
    python src/backfill_question_kps.py --subject english --include-material --answerable-only
"""

import json
import os
import re
import sys
from pathlib import Path

# 确保能 import 同目录模块（src/）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from extract import _repair_json_escapes, _strip_code_fence  # noqa: E402

BATCH_SIZE = 10          # 每批调 LLM 的题数
MAX_KPS_PER_QUESTION = 3  # 每题最多知识点数（brief 约定 1-3）
MAX_CONTENT_LEN = 500     # 题面截断长度（字符）
MAX_MATERIAL_LEN = 4000   # 材料截断长度（字符；一篇英语阅读通常 1.5–2.5k 字符）
SUBJECT_ID_MATH = 1       # subjects 种子：math

# 本地推理模型（Qwen thinking）可能先输出推理段再输出 JSON
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


# ---------------------------------------------------------------------------
# 输出清洗 + JSON 提取（纯函数）
# ---------------------------------------------------------------------------

def _clean_llm_text(raw: str) -> str:
    """剥推理段（think 标签）+ markdown 代码围栏，返回待解析文本。"""
    text = (raw or "").strip()
    text = _THINK_RE.sub("", text).strip()
    if not text:
        return ""
    fenced = _strip_code_fence(text)
    return fenced if fenced != text else text


def _json_candidates(text: str) -> list[str]:
    """依次尝试的 JSON 候选：原样 / 反斜杠修复 / 最外层 {...} / 最外层 [...]。"""
    candidates = [text]
    repaired = _repair_json_escapes(text)
    if repaired != text:
        candidates.append(repaired)
    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        start, end = text.find(open_ch), text.rfind(close_ch)
        if start != -1 and end > start:
            candidates.append(text[start:end + 1])
    return candidates


def _loads_first(text: str):
    """依次尝试候选 JSON 文本，返回第一个解析成功的结果；全失败返回 None。"""
    for cand in _json_candidates(text):
        for attempt in (cand, _repair_json_escapes(cand)):
            try:
                return json.loads(attempt)
            except (json.JSONDecodeError, ValueError):
                continue
    return None


# ---------------------------------------------------------------------------
# kp id 过滤（纯函数）
# ---------------------------------------------------------------------------

def _filter_kps(kps: object, whitelist: dict[int, str]) -> list[int]:
    """kp 数组 -> 白名单内、去重（保序）、截前 MAX_KPS_PER_QUESTION 个。

    非数组、非整数元素（含 bool——bool 是 int 子类需显式排除）、白名单外 id
    一律丢弃；不因个别非法元素导致整题失败。
    """
    if not isinstance(kps, list):
        return []
    result: list[int] = []
    for kp in kps:
        if isinstance(kp, bool) or not isinstance(kp, int):
            continue
        if kp not in whitelist:
            continue
        if kp not in result:
            result.append(kp)
        if len(result) >= MAX_KPS_PER_QUESTION:
            break
    return result


# ---------------------------------------------------------------------------
# LLM 输出解析（纯函数）
# ---------------------------------------------------------------------------

def parse_kp_response(raw: str, whitelist: dict[int, str]) -> list[int]:
    """解析 LLM 单题输出：{"kps": [1, 17]} 或裸数组 [1, 17]。

    白名单过滤、去重、超 3 截前 3；非法 JSON / 非数组 / 无 kps 字段返回 []
    （调用方按失败处理，可重试）。容错代码围栏与 think 推理段。
    """
    text = _clean_llm_text(raw)
    if not text:
        return []
    data = _loads_first(text)
    if data is None:
        return []
    if isinstance(data, dict):
        kps = data.get("kps")
    elif isinstance(data, list):
        kps = data
    else:
        return []
    return _filter_kps(kps, whitelist)


def parse_batch_response(raw: str, whitelist: dict[int, str]) -> dict[int, list[int]]:
    """解析 LLM 批量输出：{"items": [{"qid": 123, "kps": [1, 17]}]}。

    返回 qid -> 过滤后 kps 的映射；kps 为空（全非法/空数组）的题不出现
    （调用方按失败处理）。非 dict 元素、qid 非整数、重复 qid（首个生效）跳过。
    非法 JSON 返回 {}。
    """
    text = _clean_llm_text(raw)
    if not text:
        return {}
    data = _loads_first(text)
    if not isinstance(data, dict):
        return {}
    items = data.get("items")
    if not isinstance(items, list):
        return {}
    result: dict[int, list[int]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        qid = item.get("qid")
        if isinstance(qid, bool) or not isinstance(qid, int):
            continue
        kps = _filter_kps(item.get("kps"), whitelist)
        if not kps:
            continue
        if qid not in result:  # 重复 qid 首个生效
            result[qid] = kps
    return result


# ---------------------------------------------------------------------------
# SQL 构造（纯函数）
# ---------------------------------------------------------------------------

def build_question_select_sql(subject_id: int, include_material: bool,
                              answerable_only: bool) -> str:
    """未标注本学科题的 SELECT；两个开关默认关，过滤条件与改造前一致。

    include_material 额外取 material_text/material_url（英语阅读/完形必需；
    默认不取，其它学科的 SQL 与旧版等价）。
    answerable_only 只留在架且有标准答案的题（英语本次只标可练题）。
    """
    cols = "q.id, q.content, q.options, q.type"
    if include_material:
        cols += ", q.material_text, q.material_url"
    where = ["qkp.question_id IS NULL", "q.subject_id = %s"]
    if answerable_only:
        where.append("q.is_active = 1")
        where.append("COALESCE(TRIM(q.answer), '') <> ''")
    return (
        f"SELECT {cols} FROM questions q "
        "LEFT JOIN question_knowledge_points qkp ON qkp.question_id = q.id "
        f"WHERE {' AND '.join(where)} ORDER BY q.id"
    )


# ---------------------------------------------------------------------------
# 材料读取
# ---------------------------------------------------------------------------

def _read_material_doc(output_dir, url: str | None) -> str | None:
    """读 material_url 指向的文档正文（output_dir/assets/<url>）；缺文件返回 None，不抛。"""
    if not url:
        return None
    try:
        return (Path(output_dir) / "assets" / url).read_text(encoding="utf-8")
    except OSError:
        return None


def _load_question_material(output_dir, material_text: str | None,
                            material_url: str | None) -> tuple[str | None, str | None]:
    """返回 (材料正文, 错误原因)。

    material_text 是题内材料，material_url 是共享文章正文，两者都有就拼接；
    url 有值但读不到文件 → (None, 原因)，由调用方把该题记 failed——
    **不得退化成只看选项猜测**。无任何材料 → (None, None)。
    """
    parts: list[str] = []
    if material_text and material_text.strip():
        parts.append(material_text.strip())
    if material_url:
        body = _read_material_doc(output_dir, material_url)
        if body is None:
            return None, f"material_url 读取失败: {material_url}"
        if body.strip():
            parts.append(body.strip())
    if not parts:
        return None, None
    return "\n\n".join(parts), None


def _row_to_item(row, output_dir, include_material: bool) -> dict:
    """DB 行 -> 题目块输入。默认路径只取前三列（旧行为）。"""
    qid, content, options = row[0], row[1], row[2]
    if not include_material:
        return {"qid": qid, "content": content, "options": options,
                "qtype": None, "material": None, "material_error": None}
    qtype, material_text, material_url = row[3], row[4], row[5]
    material, material_error = _load_question_material(output_dir, material_text,
                                                       material_url)
    return {"qid": qid, "content": content, "options": options,
            "qtype": qtype, "material": material, "material_error": material_error}


# ---------------------------------------------------------------------------
# user message 构建（纯函数）
# ---------------------------------------------------------------------------

def _format_options(raw) -> str:
    """DB 里的 options JSON -> `A. xxx B. yyy` 一行；解析不了返回空串。"""
    if not raw:
        return ""
    data = raw
    if isinstance(raw, (str, bytes)):
        try:
            data = json.loads(raw)
        except Exception:
            return ""
    if not isinstance(data, list):
        return ""
    parts = []
    for opt in data:
        if not isinstance(opt, dict):
            continue
        label = str(opt.get("label") or "").strip()
        text = str(opt.get("text") or "").strip()
        if text:
            parts.append(f"{label}. {text}" if label else text)
    return " ".join(parts)


def build_question_block(qid: int, content, options, qtype: str | None = None,
                         material: str | None = None,
                         material_error: str | None = None) -> str | None:
    """单题块。material 为 None 时输出与旧版逐字一致（回归钉子）。

    material 非 None 表示开了 --include-material：附题型与材料正文；
    材料读取失败（material_error）返回 None，由调用方记 failed；
    题干与材料都为空也返回 None（没有可判断的题面，不能只靠选项猜）。
    """
    if material_error:
        return None
    opts_text = _format_options(options)
    if material is None:
        truncated = (content or "")[:MAX_CONTENT_LEN]
        line = f"[qid {qid}] {truncated}"
        if opts_text:
            line += f"\n  选项：{opts_text}"
        return line

    stem = (content or "").strip()
    body = (material or "").strip()
    if not stem and not body:
        return None
    parts = [f"[qid {qid}]"]
    if qtype:
        parts.append(f"  题型：{qtype}")
    if stem:
        parts.append(f"  题干：{stem[:MAX_CONTENT_LEN]}")
    if body:
        parts.append(f"  材料：{body[:MAX_MATERIAL_LEN]}")
    if opts_text:
        parts.append(f"  选项：{opts_text}")
    return "\n".join(parts)


def _block_of(item) -> str | None:
    """元组 (qid, content, options) = 旧格式；dict 额外带 qtype/material/material_error。"""
    if isinstance(item, dict):
        return build_question_block(
            item["qid"], item.get("content"), item.get("options"),
            item.get("qtype"), item.get("material"), item.get("material_error"),
        )
    qid, content, options = item
    return build_question_block(qid, content, options)


def build_user_message(whitelist: dict[int, str],
                       questions: list) -> str:
    """白名单 id+name 清单 + 每题一个题目块。

    题面必须带上选项：物理/化学大量客观题的题干只有「下列说法正确的是」，
    真正的考点全在选项里，只给题干会让模型瞎标（2026-10-30 实测）。
    questions 元素可以是 (qid, content, options) 元组（旧格式，options 为
    DB 原样 JSON 字符串 / 已解析列表 / None），也可以是带
    qid/content/options/qtype/material/material_error 的 dict（材料模式）。
    """
    lines = ["知识点白名单（id: 名称）："]
    for kp_id, name in whitelist.items():
        lines.append(f"{kp_id}: {name}")
    lines.append("")
    lines.append("题目（[qid 编号] 题面）：")
    for item in questions:
        block = _block_of(item)
        if block is not None:
            lines.append(block)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# main（LLM + DB）
# ---------------------------------------------------------------------------

_SUBJECT_NAMES = {
    "math": "数学", "chinese": "语文", "english": "英语", "physics": "物理",
    "chemistry": "化学", "politics": "道德与法治",
    "biology": "生物", "history": "历史", "geography": "地理",
}


def _load_kps_prompt(subject: str) -> str:
    """知识点标定提示词 = 公共契约 + 学科选点规则。

    此前只有「数学版」和「语文版」两份：英语/物理/化学/道法标 KP 时用的是
    「你是经验丰富的初中数学老师」，选点规则也按数学写。拆成一科一份后，
    公共 JSON 契约只在 `_common.txt` 维护，学科差异写在 `<subject>.txt`。
    """
    base = Path(__file__).parent / "prompts" / "question_kps"
    common = (base / "_common.txt").read_text(encoding="utf-8")
    subject_file = base / f"{subject}.txt" if subject else None
    if subject_file is None or not subject_file.exists():
        subject_file = base / "_generic.txt"
    return (
        common
        .replace("{{subject_name}}", _SUBJECT_NAMES.get(subject, "学科"))
        .replace("{{subject_rules}}", subject_file.read_text(encoding="utf-8").strip())
    )


def main():
    import argparse

    import pymysql

    from config import RefineryConfig
    from llm import create_llm_client

    # --limit N：小样本验证（如 --limit 5 先验证标注质量再全量跑）
    # --subject：学科 code（默认 math；语文 chinese 需先跑语文 KP 种子迁移）
    parser = argparse.ArgumentParser(description="题目 KP 标注回填")
    parser.add_argument("--limit", type=int, default=None,
                        help="只标注前 N 题（验证质量用；缺省全量）")
    parser.add_argument("--subject", default="math",
                        help="学科 code（默认 math；语文用 chinese）")
    parser.add_argument("--include-material", action="store_true",
                        help="读取 material_text/material_url 并随题目送模型"
                             "（英语阅读/完形必需）")
    parser.add_argument("--answerable-only", action="store_true",
                        help="只标注在架且有标准答案的题（英语本次只标可练题）")
    args = parser.parse_args()

    cfg = RefineryConfig.from_env()

    # LLM 客户端（与 backfill_practice_questions.py 同款构造）
    llm = create_llm_client(
        provider=cfg.llm_provider,
        api_key=cfg.llm_api_key or "",
        auth_token=cfg.llm_auth_token,
        model=cfg.llm_model,
        base_url=cfg.llm_base_url,
        timeout=cfg.llm_timeout,
        max_tokens=cfg.llm_max_tokens,
        max_retries=cfg.llm_max_retries,
        thinking=cfg.llm_thinking,
        enable_cache=cfg.llm_enable_cache,
    )
    system_prompt = _load_kps_prompt(args.subject)

    # DB 连接（与 DbLoader.__init__ 同款 pymysql.connect）
    conn = pymysql.connect(
        host=cfg.db_host,
        port=cfg.db_port,
        user=cfg.db_user,
        password=cfg.db_pass,
        database=cfg.db_name,
        charset="utf8mb4",
    )
    try:
        # 0. 学科 code -> id（--subject，默认 math）
        with conn.cursor() as cur:
            cur.execute("SELECT id, name FROM subjects WHERE code = %s", (args.subject,))
            row = cur.fetchone()
        if not row:
            print(f"[error] 未知学科 code={args.subject!r}", flush=True)
            return
        subject_id, subject_name = row

        # 1. KP 白名单
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name FROM knowledge_points WHERE subject_id = %s",
                (subject_id,),
            )
            whitelist = {row[0]: row[1] for row in cur.fetchall()}
        if not whitelist:
            print(f"[error] {subject_name} 的 knowledge_points 为空（subject_id={subject_id}），"
                  f"先跑对应 KP 种子迁移", flush=True)
            return

        # 2. 幂等：只取无 qkp 记录的本学科题（subject 过滤与白名单一致——
        #    KP 白名单是本科知识点，他科题不能参与标注）
        include_material = args.include_material
        with conn.cursor() as cur:
            cur.execute(
                build_question_select_sql(subject_id, include_material,
                                          args.answerable_only),
                (subject_id,),
            )
            rows = cur.fetchall()

        if args.limit is not None:
            rows = rows[:args.limit]
        total = len(rows)
        if total == 0:
            print("[done] 所有题均已标注，无需回填", flush=True)
            return
        print(f"[start] 待标注 {total} 题（白名单 {len(whitelist)} 个知识点，"
              f"批大小 {BATCH_SIZE}）", flush=True)

        # 3. 分批调 LLM
        labeled = 0
        failed_ids: list[int] = []
        for i in range(0, total, BATCH_SIZE):
            batch = rows[i:i + BATCH_SIZE]
            batch_no = i // BATCH_SIZE + 1
            batch_total = (total + BATCH_SIZE - 1) // BATCH_SIZE

            # 材料读取失败 / 无题面无材料的题先剔出本批，记 failed，不送模型猜
            items: list[dict] = []
            batch_failed = 0
            for row in batch:
                item = _row_to_item(row, cfg.output_dir, include_material)
                if item["material_error"]:
                    print(f"[WARN] qid {item['qid']}: {item['material_error']}，记失败",
                          flush=True)
                if _block_of(item) is None:
                    failed_ids.append(item["qid"])
                    batch_failed += 1
                    continue
                items.append(item)
            if not items:
                print(f"[ok] batch {batch_no}/{batch_total}: labeled=0, "
                      f"failed={batch_failed}", flush=True)
                continue

            user_msg = build_user_message(whitelist, items)
            try:
                response = llm.complete(system_prompt, user_msg)
            except Exception as e:
                print(f"[WARN] batch {batch_no}: LLM 调用失败（{e}），"
                      f"本批 {len(items)} 题记失败", flush=True)
                failed_ids.extend(item["qid"] for item in items)
                batch_failed += len(items)
                continue

            kps_map = parse_batch_response(response.content, whitelist)
            batch_labeled = 0
            for item in items:
                qid = item["qid"]
                kps = kps_map.get(qid)
                if not kps:
                    # LLM 漏答 / 输出全非法：记失败，可重跑补齐
                    failed_ids.append(qid)
                    batch_failed += 1
                    continue
                with conn.cursor() as cur:
                    for kp_id in kps:
                        cur.execute(
                            "INSERT IGNORE INTO question_knowledge_points "
                            "(question_id, knowledge_point_id, role) "
                            "VALUES (%s, %s, 'primary')",
                            (qid, kp_id),
                        )
                conn.commit()
                labeled += 1
                batch_labeled += 1
            print(f"[ok] batch {batch_no}/{batch_total}: "
                  f"labeled={batch_labeled}, failed={batch_failed}",
                  flush=True)

        # 4. 统计
        print(f"backfill 完成：labeled={labeled}, failed={len(failed_ids)}, "
              f"total={total}", flush=True)
        if failed_ids:
            print(f"失败题 id（重跑本脚本即可补齐）：{failed_ids}", flush=True)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
