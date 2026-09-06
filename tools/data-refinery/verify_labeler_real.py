"""端到端真实数据验证：西城模拟二试卷 → 切题 → 真实本地 LLM 标注。

验证两件事：
1. question_splitter 切题是否正确（content 完整、答案对齐）
2. 真实 LLM 输出是否合规（JSON 格式、type/difficulty/kp 正确、thinking 是否关闭）

只标前 5 道题（控制 LLM 成本）。打印每题切分结果 + LLM 原始输出 + 解析后字段。
"""

import os
import re
import sys
from pathlib import Path

# 让脚本能 import data-refinery/src 下的模块
SRC = Path(__file__).resolve().parent / "src"
sys.path.insert(0, str(SRC))

# 切到 data-refinery 目录加载 .env
os.chdir(Path(__file__).resolve().parent)

from config import RefineryConfig
from llm import create_llm_client
from answer_merger import maybe_merge_answer_md
from question_splitter import split_page
from question_labeler import QuestionLabeler
import pymysql


PAPER_MD = (Path(__file__).resolve().parent
            / "output/md/数学/初中/second/2026/"
            / "数学-初三(下)-202607-西城-模拟二-试卷"
            / "数学-初三(下)-202607-西城-模拟二-试卷.md")


def query_real_kps(cfg, subject_code="math"):
    """从 DB 查真实知识点列表（动态注入 prompt）。"""
    conn = pymysql.connect(
        host=cfg.db_host, port=cfg.db_port,
        user=cfg.db_user, password=cfg.db_pass,
        database=cfg.db_name, charset="utf8mb4",
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT code, name FROM knowledge_points "
                "WHERE subject_id=(SELECT id FROM subjects WHERE code=%s) "
                "ORDER BY code",
                (subject_code,),
            )
            return [{"code": r[0], "name": r[1]} for r in cur.fetchall()]
    finally:
        conn.close()


def main():
    cfg = RefineryConfig.from_env()
    print(f"[config] provider={cfg.llm_provider} model={cfg.llm_model} "
          f"base_url={cfg.llm_base_url} thinking={cfg.llm_thinking}")

    # 1. 读真实试卷 MD
    paper_text = PAPER_MD.read_text(encoding="utf-8")
    print(f"[paper] MD 字符数: {len(paper_text)}")

    # 2. answer_merger 处理（西城只有试卷 MD，无答案 MD → case 1）
    merged = maybe_merge_answer_md(PAPER_MD, paper_text)
    print(f"[merge] 合并后字符数: {len(merged)} (case 1: 试卷自带答案)")

    # 3. 切题
    questions = split_page(merged, PAPER_MD)
    print(f"[split] 切出 {len(questions)} 道题\n")
    for q in questions:
        content_preview = (q.content or "")[:60].replace("\n", " ")
        ans_preview = (q.answer or "")[:40].replace("\n", " ")
        print(f"  题{q.group_order} (group={q.group_id}): {content_preview}... | ans: {ans_preview}")

    # 4. 创建真实 LLM 客户端
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

    # 5. 查真实 KP 列表
    kps = query_real_kps(cfg, "math")
    print(f"\n[kp] DB 查到 {len(kps)} 个知识点")
    prompt = (SRC / "prompts" / "question_labeler.txt").read_text(encoding="utf-8")
    labeler = QuestionLabeler(llm=llm, prompt=prompt, knowledge_points=kps)

    # 6. 标前 5 道题（每题单独调，看 LLM 原始输出）
    test_questions = questions[:5]
    print(f"\n[llm] 标注前 {len(test_questions)} 道题...\n")
    for q in test_questions:
        user = labeler._build_single_prompt(q.content)
        print(f"=== 题 {q.group_order} ===")
        print(f"  content 前 120: {q.content[:120].replace(chr(10), ' ')}")
        try:
            resp = llm.complete(prompt, user)
            raw = resp.content
            # 看 thinking 是否出现
            has_thinking = "</think>" in raw or "</think>" in raw
            print(f"  LLM 原始输出长度: {len(raw)} 字符 | 含 thinking 标签: {has_thinking}")
            print(f"  LLM 原始输出前 500: {raw[:500]}")
            # 解析
            from extract import _parse_json_object
            try:
                data = _parse_json_object(raw)
                item = data.get("items", [{}])[0] if "items" in data else data
                print(f"  → type={item.get('type')} difficulty={item.get('difficulty')} "
                      f"kp={item.get('knowledge_points')} suggested_new={item.get('suggested_new_kps')}")
            except Exception as e:
                print(f"  → JSON 解析失败: {e}")
        except Exception as e:
            print(f"  LLM 调用失败: {e}")
        print()


if __name__ == "__main__":
    main()
