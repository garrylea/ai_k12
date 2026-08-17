"""单卡 labeler 测试：验证 practice 卡 content 每题独立成行后 LLM 标注质量。

用法：python test_labeler_single_card.py [--card-id 441]
"""

import argparse
import json
import os
import sys

import pymysql
from dotenv import load_dotenv

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

load_dotenv()

from card_labeler import CardLabeler  # noqa: E402
from llm import create_llm_client  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--card-id", type=int, default=441)
    args = parser.parse_args()

    # 1. 读 DB 中的 card
    conn = pymysql.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "ai_k12"),
        password=os.getenv("DB_PASSWORD", "ai_k12"),
        database=os.getenv("DB_NAME", "ai_k12"),
        charset="utf8mb4",
    )
    cur = conn.cursor()
    cur.execute(
        "SELECT id, content, content_metadata, textbook_page FROM cards WHERE id=%s",
        (args.card_id,),
    )
    row = cur.fetchone()
    if not row:
        print(f"Card ID={args.card_id} 不存在")
        sys.exit(1)
    cid, content, cm_json, page = row
    old_cm = json.loads(cm_json) if cm_json else {}
    conn.close()

    print(f"=== Card ID={cid}  page={page} ===")
    print(f"Content 长度: {len(content)} 字")
    print(f"现有 questions: {len(old_cm.get('questions', []))} 题")
    print(f"现有 intro: {old_cm.get('intro', '(无)')[:120]}")
    print()

    # 2. 调 LLM labeler
    prompt_path = os.path.join(os.path.dirname(__file__), "src", "prompts", "textbook_cards.txt")
    with open(prompt_path, encoding="utf-8") as f:
        prompt_template = f.read()

    llm = create_llm_client(
        provider=os.getenv("LLM_PROVIDER", "openai"),
        api_key=os.getenv("OPENAI_API_KEY") or os.getenv("ANTHROPIC_API_KEY") or "",
        auth_token=os.getenv("LLM_AUTH_TOKEN") or os.getenv("ANTHROPIC_AUTH_TOKEN"),
        model=os.getenv("LLM_MODEL", "gpt-4o"),
        base_url=os.getenv("LLM_BASE_URL") or os.getenv("ANTHROPIC_BASE_URL"),
        timeout=int(os.getenv("LLM_TIMEOUT", "120")),
        max_tokens=int(os.getenv("LLM_MAX_TOKENS", "16384")),
    )
    labeler = CardLabeler(llm=llm, prompt_template=prompt_template)

    print("调用 LLM labeler（传完整 content，不截断）...")
    # 注意：labeler.label 默认截断 content[:800]，这里手动绕过截断
    # 通过传入完整 content 作为一个 card
    result = labeler.label(
        [content],  # 单卡
        page_number=f"P{page}" if page else "P11",
        prev_lesson_id=None,
    )

    print(f"\n=== LLM 标注结果 ===")
    for i, label in enumerate(result.labels):
        print(f"  card_type: {label.card_type}")
        print(f"  page_type: {label.page_type}")
        print(f"  intro: {label.intro}")
        if label.questions:
            print(f"  questions ({len(label.questions)} 题):")
            for q in label.questions:
                print(f"    [{q.n}] {q.text[:100]}")
        else:
            print(f"  questions: (无)")
        print()


if __name__ == "__main__":
    main()
