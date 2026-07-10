from unittest.mock import patch

from cli import main


class TestCliDispatch:
    def test_dispatches_convert_command(self):
        with patch("convert_cli.main") as mock:
            main(["convert", "--dry-run"])
            mock.assert_called_once_with(["--dry-run"])

    def test_dispatches_extract_command(self):
        with patch("extract_cli.main") as mock:
            main(["extract", "--dry-run"])
            mock.assert_called_once_with(["--dry-run"])

    def test_unknown_command_raises_system_exit(self):
        with patch("sys.exit") as mock_exit:
            main(["unknown"])
            mock_exit.assert_called_once()
