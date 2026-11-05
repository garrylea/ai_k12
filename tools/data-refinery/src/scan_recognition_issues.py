"""单独跑识别问题扫描（import_cli 第 6 步已自动执行，这里用于补跑/看明细）。

用法：
    python3 src/scan_recognition_issues.py --subject 物理
    python3 src/scan_recognition_issues.py --subject 物理 --file 人大附中
    python3 src/scan_recognition_issues.py --subject 物理 --dry-run
"""

import argparse

from recognition_scan import run


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--subject", default="物理", help="学科中文名过滤")
    parser.add_argument("--file", help="卷名子串过滤")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不写清单")
    args = parser.parse_args()

    issues = run(args.subject, args.file, write=not args.dry_run)
    if args.dry_run:
        for it in issues:
            print(f"[issue] {it['source'][:24]} 题{it['group_order']} {it['kind']}："
                  f"{'；'.join(it['reasons'])}")
            if it.get("suspect_group_order"):
                print(f"        疑被题{it['suspect_group_order']}吸收")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
