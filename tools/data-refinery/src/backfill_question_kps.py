"""一次性回填：用 LLM 给题库每题标 1-3 个知识点（question_knowledge_points，role='primary'）。

流程（main，镜像 backfill_practice_questions.py）：
1. 加载 KP 白名单（knowledge_points，subject_id=1 即数学）。
2. SELECT 未标注的数学题（LEFT JOIN question_knowledge_points qkp ... IS NULL，
   且 q.subject_id=1 与白名单学科一致——库中含化学等他科题，不限定会把数学
   KP 错标到他科题上）——幂等，已有 qkp 记录的题不再处理。
3. 每批 10 题调 LLM（prompt 附白名单 id+name 清单 + 每题 qid/题面截断 500 字），
   要求输出 {"items": [{"qid": 123, "kps": [1, 17]}]}，按 qid 对回每题
   （LLM 漏答/输出非法的题记失败，可重跑补齐）。
4. 白名单校验（parse_batch_response 内过滤）后 INSERT IGNORE 写入
   （question_knowledge_points 有 uniq_qkp_q_kp 唯一键，重复执行不插重）。
5. 打印统计：标注数 / 失败题 id 清单。

纯函数（可测，LLM 不参与）：parse_kp_response / parse_batch_response /
build_user_message / _filter_kps。LLM 与 DB 只出现在 main。

用法：cd tools/data-refinery && python src/backfill_question_kps.py
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
# user message 构建（纯函数）
# ---------------------------------------------------------------------------

def build_user_message(whitelist: dict[int, str],
                       questions: list[tuple[int, str]]) -> str:
    """白名单 id+name 清单 + 每题 [qid n] 题面（截断 MAX_CONTENT_LEN 字）。"""
    lines = ["知识点白名单（id: 名称）："]
    for kp_id, name in whitelist.items():
        lines.append(f"{kp_id}: {name}")
    lines.append("")
    lines.append("题目（[qid 编号] 题面）：")
    for qid, content in questions:
        truncated = (content or "")[:MAX_CONTENT_LEN]
        lines.append(f"[qid {qid}] {truncated}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# main（LLM + DB）
# ---------------------------------------------------------------------------

def _load_prompt(name: str) -> str:
    """加载 prompts/{name}.txt（与 backfill_practice_questions 同款）。"""
    prompt_path = Path(__file__).parent / "prompts" / f"{name}.txt"
    return prompt_path.read_text(encoding="utf-8")


def main():
    import pymysql

    from config import RefineryConfig
    from llm import create_llm_client

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
    system_prompt = _load_prompt("question_kps")

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
        # 1. KP 白名单
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name FROM knowledge_points WHERE subject_id = %s",
                (SUBJECT_ID_MATH,),
            )
            whitelist = {row[0]: row[1] for row in cur.fetchall()}
        if not whitelist:
            print("[error] knowledge_points 为空（subject_id=1），先跑 "
                  "generate_kp_tree.py 种子", flush=True)
            return

        # 2. 幂等：只取无 qkp 记录的数学题（subject 过滤与白名单一致——
        #    KP 白名单是数学知识点，库中的化学等他科题不能参与标注）
        with conn.cursor() as cur:
            cur.execute(
                "SELECT q.id, q.content FROM questions q "
                "LEFT JOIN question_knowledge_points qkp "
                "  ON qkp.question_id = q.id "
                "WHERE qkp.question_id IS NULL "
                "  AND q.subject_id = %s "
                "ORDER BY q.id",
                (SUBJECT_ID_MATH,),
            )
            rows = cur.fetchall()

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
            user_msg = build_user_message(whitelist,
                                          [(r[0], r[1]) for r in batch])
            try:
                response = llm.complete(system_prompt, user_msg)
            except Exception as e:
                print(f"[WARN] batch {batch_no}: LLM 调用失败（{e}），"
                      f"本批 {len(batch)} 题记失败", flush=True)
                failed_ids.extend(r[0] for r in batch)
                continue

            kps_map = parse_batch_response(response.content, whitelist)
            batch_failed = 0
            for qid, _content in batch:
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
            print(f"[ok] batch {batch_no}/{(total + BATCH_SIZE - 1) // BATCH_SIZE}: "
                  f"labeled={len(batch) - batch_failed}, failed={batch_failed}",
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
