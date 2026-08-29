"""pipeline_cli 测试：验证各阶段调用顺序、参数透传与 --skip/--source 语义。"""
from unittest.mock import MagicMock, patch


def _run(tmp_path, argv, order=None):
    """在 mock 掉全部子入口的情况下运行 pipeline main；order 记录调用顺序。"""
    import pipeline_cli

    if order is None:
        order = []

    mock_config = MagicMock()
    mock_config.from_env.return_value = MagicMock(output_dir=tmp_path)
    with patch.object(pipeline_cli, "ensure_refinery_env") as ensure_env, \
         patch.object(pipeline_cli, "RefineryConfig", mock_config), \
         patch.object(pipeline_cli, "toc_parse_main") as toc, \
         patch.object(pipeline_cli, "extract_main") as extract, \
         patch.object(pipeline_cli, "publish_main") as publish, \
         patch.object(pipeline_cli, "run_merge") as merge, \
         patch.object(pipeline_cli, "db_loader_main") as db_loader:
        toc.side_effect = lambda a: order.append("toc")
        extract.side_effect = lambda a: order.append("extract")
        publish.side_effect = lambda a: order.append("publish")
        merge.side_effect = lambda *a, **k: order.append("merge")
        db_loader.side_effect = lambda a: order.append("load")
        ensure_env.side_effect = lambda: order.append("ensure_env")
        pipeline_cli.main(argv)
    return {
        "ensure_env": ensure_env, "toc": toc, "extract": extract,
        "publish": publish, "merge": merge, "db_loader": db_loader,
        "output_dir": tmp_path,
    }


class TestPipelineCli:
    def test_runs_all_stages_in_order(self, tmp_path):
        order: list = []
        m = _run(tmp_path, ["--source", "all"], order)
        assert order == ["ensure_env", "toc", "extract", "publish", "merge", "load"]

    def test_default_incremental_load(self, tmp_path):
        m = _run(tmp_path, ["--source", "all"])
        m["db_loader"].assert_called_once_with(
            ["--source", "all", "--toc-dir", str(m["output_dir"] / "toc"), "--load-cards"])

    def test_purge_business_data_full_reload(self, tmp_path):
        m = _run(tmp_path, ["--source", "all", "--purge-business-data"])
        m["db_loader"].assert_called_once_with(
            ["--source", "all", "--toc-dir", str(m["output_dir"] / "toc"),
             "--purge-business-data"])

    def test_dry_run_passed_to_all_stages(self, tmp_path):
        m = _run(tmp_path, ["--source", "all", "--dry-run"])
        m["toc"].assert_called_once_with(["--source", "smartedu", "--dry-run"])
        m["extract"].assert_called_once_with(
            ["--source", "all", "--toc-dir", str(m["output_dir"] / "toc"), "--dry-run"])
        m["publish"].assert_called_once_with(["--source", "all", "--dry-run"])
        m["merge"].assert_called_once_with(m["output_dir"], source="all", dry_run=True)
        m["db_loader"].assert_called_once_with(
            ["--source", "all", "--toc-dir", str(m["output_dir"] / "toc"),
             "--dry-run", "--load-cards"])

    def test_source_zgkao_skips_toc_stage(self, tmp_path):
        m = _run(tmp_path, ["--source", "zgkao"])
        m["toc"].assert_not_called()
        m["extract"].assert_called_once_with(
            ["--source", "zgkao", "--toc-dir", str(m["output_dir"] / "toc")])
        m["publish"].assert_called_once_with(["--source", "zgkao"])
        m["db_loader"].assert_called_once_with(
            ["--source", "zgkao", "--toc-dir", str(m["output_dir"] / "toc"), "--load-cards"])

    def test_source_smartedu_runs_toc(self, tmp_path):
        m = _run(tmp_path, ["--source", "smartedu"])
        m["toc"].assert_called_once_with(["--source", "smartedu"])

    def test_skip_flags(self, tmp_path):
        m = _run(tmp_path, ["--skip-toc", "--skip-extract", "--skip-publish", "--skip-load"])
        m["toc"].assert_not_called()
        m["extract"].assert_not_called()
        m["publish"].assert_not_called()
        m["merge"].assert_not_called()
        m["db_loader"].assert_not_called()

    def test_skip_load_still_runs_extract_publish(self, tmp_path):
        m = _run(tmp_path, ["--skip-load"])
        m["extract"].assert_called_once()
        m["publish"].assert_called_once()
        m["merge"].assert_not_called()
        m["db_loader"].assert_not_called()

    def test_throttle_args_passthrough(self, tmp_path):
        m = _run(tmp_path, ["--interval", "2.5", "--batch-size", "10", "--batch-sleep", "60"])
        m["extract"].assert_called_once_with(
            ["--source", "all", "--toc-dir", str(m["output_dir"] / "toc"),
             "--interval", "2.5", "--batch-size", "10", "--batch-sleep", "60.0"])

    def test_no_throttle_args_by_default(self, tmp_path):
        m = _run(tmp_path, ["--source", "all"])
        argv = m["extract"].call_args.args[0]
        assert "--interval" not in argv
        assert "--batch-size" not in argv
        assert "--batch-sleep" not in argv

    def test_ensure_refinery_env_runs_before_any_stage(self, tmp_path):
        order: list = []
        _run(tmp_path, ["--source", "all"], order)
        assert order[0] == "ensure_env"


class TestPipelineCliWizard:
    """无参数运行 → 交互式向导；带参数 → 直接执行。"""

    def _run_no_argv(self, tmp_path, wizard_result, order=None):
        import pipeline_cli
        from unittest.mock import MagicMock

        mock_config = MagicMock()
        mock_config.from_env.return_value = MagicMock(output_dir=tmp_path)
        with patch.object(pipeline_cli, "ensure_refinery_env"), \
             patch.object(pipeline_cli, "RefineryConfig", mock_config), \
             patch("pipeline_wizard.run_wizard", return_value=wizard_result) as wizard, \
             patch("pipeline_wizard.apply_model_env") as apply_env, \
             patch.object(pipeline_cli, "toc_parse_main"), \
             patch.object(pipeline_cli, "extract_main"), \
             patch.object(pipeline_cli, "publish_main"), \
             patch.object(pipeline_cli, "run_merge"), \
             patch.object(pipeline_cli, "db_loader_main"):
            pipeline_cli.main()
        return wizard, apply_env

    def test_no_argv_triggers_wizard_and_executes(self, tmp_path):
        wizard, apply_env = self._run_no_argv(
            tmp_path, wizard_result=(["--source", "smartedu"], None))
        wizard.assert_called_once()
        apply_env.assert_not_called()  # 未选其他模型

    def test_no_argv_wizard_model_override_applied(self, tmp_path):
        model_env = {"LLM_PROVIDER": "qwen", "LLM_MODEL": "qwen3.7-max",
                     "LLM_AUTH_TOKEN": "sk-x", "LLM_BASE_URL": ""}
        wizard, apply_env = self._run_no_argv(
            tmp_path, wizard_result=(["--source", "all"], model_env))
        apply_env.assert_called_once_with(model_env)

    def test_no_argv_wizard_cancel_stops_pipeline(self, tmp_path, capsys):
        import pipeline_cli
        from unittest.mock import MagicMock

        mock_config = MagicMock()
        mock_config.from_env.return_value = MagicMock(output_dir=tmp_path)
        with patch.object(pipeline_cli, "ensure_refinery_env"), \
             patch.object(pipeline_cli, "RefineryConfig", mock_config), \
             patch("pipeline_wizard.run_wizard", return_value=None), \
             patch.object(pipeline_cli, "toc_parse_main") as toc, \
             patch.object(pipeline_cli, "extract_main") as extract, \
             patch.object(pipeline_cli, "publish_main"), \
             patch.object(pipeline_cli, "run_merge"), \
             patch.object(pipeline_cli, "db_loader_main"):
            pipeline_cli.main()
        toc.assert_not_called()
        extract.assert_not_called()
        assert "已取消" in capsys.readouterr().out


class TestPipelineCliScope:
    """--book/--pages 透传给 toc_parse 和 extract；publish 收到 scope + reconvert。"""

    BOOK = "数学/初中/人教版/九年级/上册/数学九上"

    def test_book_pages_passthrough(self, tmp_path):
        import pipeline_cli
        from unittest.mock import MagicMock

        mock_config = MagicMock()
        mock_config.from_env.return_value = MagicMock(output_dir=tmp_path)
        with patch.object(pipeline_cli, "ensure_refinery_env"), \
             patch.object(pipeline_cli, "RefineryConfig", mock_config), \
             patch.object(pipeline_cli, "toc_parse_main") as toc, \
             patch.object(pipeline_cli, "extract_main") as extract, \
             patch.object(pipeline_cli, "publish_main") as publish, \
             patch.object(pipeline_cli, "run_merge"), \
             patch.object(pipeline_cli, "db_loader_main"):
            pipeline_cli.main(["--source", "smartedu",
                               "--book", self.BOOK, "--pages", "8-30"])
        toc.assert_called_once_with(["--source", "smartedu", "--book", self.BOOK])
        extract.assert_called_once_with(
            ["--source", "smartedu", "--toc-dir", str(tmp_path / "toc"),
             "--book", self.BOOK, "--pages", "8-30"])
        # publish 也收到 scope（重发布限定在所选书/页）
        publish.assert_called_once_with(
            ["--source", "smartedu", "--book", self.BOOK, "--pages", "8-30"])

    def test_no_scope_args_by_default(self, tmp_path):
        m = _run(tmp_path, ["--source", "all"])
        argv = m["extract"].call_args.args[0]
        assert "--book" not in argv
        assert "--pages" not in argv
        pub_argv = m["publish"].call_args.args[0]
        assert "--book" not in pub_argv and "--pages" not in pub_argv

    def test_reconvert_passthrough(self, tmp_path):
        """--reconvert 只透传给 extract + publish（toc 不连带重解析）。"""
        import pipeline_cli
        from unittest.mock import MagicMock

        mock_config = MagicMock()
        mock_config.from_env.return_value = MagicMock(output_dir=tmp_path)
        with patch.object(pipeline_cli, "ensure_refinery_env"), \
             patch.object(pipeline_cli, "RefineryConfig", mock_config), \
             patch.object(pipeline_cli, "toc_parse_main") as toc, \
             patch.object(pipeline_cli, "extract_main") as extract, \
             patch.object(pipeline_cli, "publish_main") as publish, \
             patch.object(pipeline_cli, "run_merge"), \
             patch.object(pipeline_cli, "db_loader_main"):
            pipeline_cli.main(["--source", "smartedu", "--book", self.BOOK,
                               "--pages", "12-20", "--reconvert"])
        assert "--reconvert" in extract.call_args.args[0]
        pub_argv = publish.call_args.args[0]
        assert "--reconvert" in pub_argv
        assert "--pages" in pub_argv and "12-20" in pub_argv
        # toc_parse 不收到 reconvert（目录重解析需单独跑 toc_parse_cli --reconvert）
        assert "--reconvert" not in toc.call_args.args[0]

    def test_no_reconvert_by_default(self, tmp_path):
        m = _run(tmp_path, ["--source", "all"])
        assert "--reconvert" not in m["extract"].call_args.args[0]
        assert "--reconvert" not in m["publish"].call_args.args[0]
