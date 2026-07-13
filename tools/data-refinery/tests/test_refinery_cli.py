"""refinery_cli 测试：验证 publish -> db_loader 串联与 --skip 选项。"""
from unittest.mock import patch


class TestRefineryCli:
    def test_runs_publish_then_db_loader(self):
        with patch("refinery_cli.publish_main") as pub, patch("refinery_cli.db_loader_main") as dbl:
            from refinery_cli import main
            main(["--source", "all", "--dry-run"])
        pub.assert_called_once_with(["--source", "all", "--dry-run"])
        dbl.assert_called_once_with(["--source", "all", "--dry-run"])

    def test_skip_publish(self):
        with patch("refinery_cli.publish_main") as pub, patch("refinery_cli.db_loader_main") as dbl:
            from refinery_cli import main
            main(["--skip-publish", "--source", "smartedu"])
        pub.assert_not_called()
        dbl.assert_called_once_with(["--source", "smartedu"])

    def test_skip_load(self):
        with patch("refinery_cli.publish_main") as pub, patch("refinery_cli.db_loader_main") as dbl:
            from refinery_cli import main
            main(["--skip-load"])
        pub.assert_called_once_with(["--source", "all"])
        dbl.assert_not_called()
