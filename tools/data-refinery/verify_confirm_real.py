"""验证双模型确认新增 KP：标题3（已知有 suggested_new_kps）→ DeepSeek 确认。"""

import os, sys
from pathlib import Path

SRC = Path(__file__).resolve().parent / "src"
sys.path.insert(0, str(SRC))
os.chdir(Path(__file__).resolve().parent)

from config import RefineryConfig
from llm import create_llm_client
from answer_merger import maybe_merge_answer_md
from question_splitter import split_page
from question_labeler import QuestionLabeler
import pymysql


def main():
    cfg = RefineryConfig.from_env()
    # 读西城 MD，切题，找题3
    p = Path("output/md/数学/初中/second/2026/数学-初三(下)-202607-西城-模拟二-试卷/数学-初三(下)-202607-西城-模拟二-试卷.md")
    qs = split_page(maybe_merge_answer_md(p, p.read_text(encoding="utf-8")), p)
    q3 = next(q for q in qs if q.group_order == 3)
    print(f"[题3] content 前 120: {q3.content[:120]}")

    # 查真实 KP
    conn = pymysql.connect(host=cfg.db_host, port=cfg.db_port, user=cfg.db_user,
                           password=cfg.db_pass, database=cfg.db_name, charset="utf8mb4")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT code, name FROM knowledge_points "
                        "WHERE subject_id=(SELECT id FROM subjects WHERE code='math') ORDER BY code")
            kps = [{"code": r[0], "name": r[1]} for r in cur.fetchall()]
    finally:
        conn.close()
    print(f"[kp] {len(kps)} 个知识点")

    # 主模型标注题3
    prompt = (SRC / "prompts" / "question_labeler.txt").read_text(encoding="utf-8")
    main_llm = create_llm_client(
        provider=cfg.llm_provider, api_key=cfg.llm_api_key or "",
        auth_token=cfg.llm_auth_token, model=cfg.llm_model,
        base_url=cfg.llm_base_url, timeout=cfg.llm_timeout,
        max_tokens=cfg.llm_max_tokens, max_retries=cfg.llm_max_retries,
        thinking=cfg.llm_thinking, enable_cache=cfg.llm_enable_cache,
    )
    fallback_llm = create_llm_client(
        provider=cfg.llm_fallback_provider, api_key=cfg.llm_fallback_api_key or "",
        model=cfg.llm_fallback_model, base_url=cfg.llm_fallback_base_url,
        timeout=cfg.llm_timeout, max_tokens=cfg.llm_max_tokens,
        max_retries=cfg.llm_max_retries,
    )
    fallback_labeler = QuestionLabeler(llm=fallback_llm, prompt=prompt, knowledge_points=kps)
    labeler = QuestionLabeler(llm=main_llm, prompt=prompt, knowledge_points=kps,
                               fallback_labeler=fallback_labeler)

    print("\n[llm] 主模型标注题3...")
    labeled = labeler.label([q3], batch_size=1)
    print(f"  type={labeled[0].type} diff={labeled[0].difficulty} "
          f"kp={labeled[0].knowledge_points} suggested_new={labeled[0].suggested_new_kps}")

    print("\n[confirm] DeepSeek 确认新增 KP...")
    confirmed = labeler.confirm_new_kps(labeled)
    print(f"  _confirmed_new_kps={[k['name'] for k in (confirmed[0]._confirmed_new_kps or [])]}")
    print(f"  _suggested_new_kps(rejected)={[k['name'] for k in (confirmed[0]._suggested_new_kps or [])]}")
    print(f"  最终 knowledge_points={confirmed[0].knowledge_points}")


if __name__ == "__main__":
    main()
