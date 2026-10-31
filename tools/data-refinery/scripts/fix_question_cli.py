"""单独跑「逐条引导补题」（import_cli 第 7 步在交互终端下会自动进入）。

用法：
    python3 scripts/fix_question_cli.py --list              # 看还有哪些待补
    python3 scripts/fix_question_cli.py --source 人大附中    # 只处理这份卷
"""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from manual_fix import FIXES_DIR, review_pending  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", help="卷名子串过滤，如 人大附中")
    parser.add_argument("--fixes-dir", default=str(FIXES_DIR))
    parser.add_argument("--list", action="store_true", help="只列清单，不进入交互")
    args = parser.parse_args()

    review_pending(file=args.source, list_only=args.list, fixes_dir=Path(args.fixes_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
