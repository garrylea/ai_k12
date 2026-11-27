"""单独跑「逐条引导补题」（import_cli 第 7 步在交互终端下会自动进入）。

用法：
    python3 src/fix_question_cli.py --list              # 看还有哪些待补
    python3 src/fix_question_cli.py --source 人大附中    # 只处理这份卷
"""

import argparse
import sys
from pathlib import Path

from manual_fix import FIXES_DIR, review_pending


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", help="卷名子串过滤，如 人大附中")
    parser.add_argument("--fixes-dir", default=str(FIXES_DIR))
    parser.add_argument("--list", action="store_true", help="只列清单，不进入交互")
    args = parser.parse_args()

    if not args.list and not sys.stdin.isatty():
        print("[提示] 当前非交互终端，不进入逐题补题。", flush=True)
        print("       唯一入口：python3 src/fix_question_cli.py --source <卷名>", flush=True)
        return 0

    review_pending(file=args.source, list_only=args.list, fixes_dir=Path(args.fixes_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
