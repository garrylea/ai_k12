"""import_cli --preview 参数装配与互斥校验（不跑真实转换）。"""

import pytest

from import_cli import extract_argv, parse_args


def _args(*argv):
    return parse_args(list(argv))


def test_preview_forces_extract_dry_run():
    args = _args("--file", "某卷", "--preview")
    assert "--dry-run" in extract_argv(args)
    assert args.preview is True


def test_dry_run_still_forwarded():
    args = _args("--file", "某卷", "--dry-run")
    assert "--dry-run" in extract_argv(args)


def test_preview_rejects_dry_run():
    with pytest.raises(SystemExit):
        _args("--file", "某卷", "--preview", "--dry-run")


def test_preview_rejects_fix_only():
    with pytest.raises(SystemExit):
        _args("--preview", "--fix-only")
