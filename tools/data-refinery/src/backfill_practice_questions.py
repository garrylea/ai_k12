"""一次性回填：为已入库的 practice 卡补 content_metadata.questions。

A1-A3 让 card_labeler 输出 practice 卡的 intro+questions、db_loader 持久化到
content_metadata（带子串校验）。但已入库的历史 practice 卡没有 questions 标记。
本脚本遍历 DB 中 card_type='practice' 且 content_metadata 无 questions/needs_fallback
的卡，调 card_labeler 补 questions，更新 content_metadata。

幂等：已有 questions 或 needs_fallback 的卡跳过。
用法：python src/backfill_practice_questions.py
"""

import json
import os
import sys
from pathlib import Path

# 确保能 import 同目录模块（src/）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pymysql  # noqa: E402

from config import RefineryConfig  # noqa: E402
from llm import create_llm_client  # noqa: E402
from card_labeler import CardLabeler  # noqa: E402
from db_loader import build_content_metadata  # noqa: E402


def _load_prompt(name: str) -> str:
    """加载 prompts/{name}.txt 模板（与 extract_cli._load_prompt 同款）。"""
    prompt_path = Path(__file__).parent / "prompts" / f"{name}.txt"
    return prompt_path.read_text(encoding="utf-8")


def main():
    cfg = RefineryConfig.from_env()

    # LLM 客户端（与 extract_cli.py 同款构造）
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
    prompt = _load_prompt("textbook_cards")
    labeler = CardLabeler(llm=llm, prompt_template=prompt)

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
        # 取所有 practice 卡（pymysql 默认游标返回 tuple）
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, content, content_metadata "
                "FROM cards WHERE card_type='practice' "
                "ORDER BY id"
            )
            rows = cur.fetchall()

        updated = 0
        skipped = 0
        failed = 0
        for row in rows:
            card_id = row[0]
            content = row[1] or ""
            raw_md = row[2]

            # 解析既有 content_metadata（可能为 NULL 或合法 JSON 字符串）
            try:
                existing = json.loads(raw_md) if raw_md else {}
            except (json.JSONDecodeError, TypeError):
                print(f"[WARN] card id={card_id}: content_metadata 非合法 JSON，跳过",
                      flush=True)
                skipped += 1
                continue

            # 幂等：已有 groups 或 needs_fallback 则跳过
            if existing.get("groups") or existing.get("needs_fallback"):
                skipped += 1
                continue

            # 调 LLM 标注（单卡作为单页输入）
            try:
                label = labeler.label([content], f"P{card_id}").labels[0]
            except Exception as e:
                print(f"[WARN] card id={card_id}: LLM 标注失败（{e}），跳过",
                      flush=True)
                failed += 1
                continue

            # 构建 content_metadata（含子串校验：question_text_valid）
            # label.groups 为 None 时转 []，使 build_content_metadata 置 needs_fallback=True
            md = build_content_metadata(label.groups or [], content, existing)

            # 更新 DB
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE cards SET content_metadata=%s WHERE id=%s",
                    (json.dumps(md, ensure_ascii=False), card_id),
                )
            conn.commit()
            updated += 1
            groups = md.get("groups", [])
            n_qs = sum(len(g.get("questions", [])) for g in groups)
            print(f"[ok] card id={card_id}: groups={len(groups)}, questions={n_qs}, "
                  f"needs_fallback={md.get('needs_fallback')}", flush=True)

        print(
            f"backfill 完成：updated={updated}, skipped={skipped}, "
            f"failed={failed}, total={len(rows)}",
            flush=True,
        )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
