"""命令行入口：把人工补的题写库（实现在 apply_fixes.py，import_cli 第 8 步也调它）。"""

from apply_fixes import apply_record, main, pending_records  # noqa: F401

if __name__ == "__main__":
    raise SystemExit(main())
