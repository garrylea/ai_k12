"""兼容入口：实现已移到 src/apply_fixes.py（import_cli 第 8 步也要调它）。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from apply_fixes import apply_record, main, pending_records  # noqa: E402,F401

if __name__ == "__main__":
    raise SystemExit(main())
