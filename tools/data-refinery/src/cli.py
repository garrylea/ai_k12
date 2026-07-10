"""CLI 入口：分发 convert / extract 子命令。"""

import sys


def main(argv=None):
    argv = argv or sys.argv[1:]
    if len(argv) >= 1 and argv[0] == "convert":
        from convert_cli import main as convert_main
        return convert_main(argv[1:])
    if len(argv) >= 1 and argv[0] == "extract":
        from extract_cli import main as extract_main
        return extract_main(argv[1:])
    print(f"Unknown command: {argv[0] if argv else '(none)'}")
    sys.exit(1)


if __name__ == "__main__":
    main()
