"""pipeline_wizard 测试：向导流程、书目选择、模型覆盖、入库模式与确认语义。"""
from pathlib import Path

from pipeline_wizard import _list_books, run_wizard

BOOK = "数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册"


def _inputs(seq):
    it = iter(seq)
    return lambda prompt="": next(it)


def _make_books(tmp_path):
    book_dir = tmp_path / "md" / "数学/初中/人教版/九年级/上册/义务教育教科书·数学九年级上册"
    book_dir.mkdir(parents=True)
    (book_dir / "page_001.md").write_text("x", encoding="utf-8")
    (book_dir / "page_002.md").write_text("x", encoding="utf-8")
    exam_dir = tmp_path / "md" / "数学/初中/second/2024/数学-初三-模拟二-试卷"
    exam_dir.mkdir(parents=True)
    (exam_dir / "数学-初三-模拟二-试卷.md").write_text("x", encoding="utf-8")
    return tmp_path / "md"


class TestListBooks:
    def test_filters_by_source(self, tmp_path):
        md = _make_books(tmp_path)
        all_books = _list_books(md, "all")
        assert len(all_books) == 2
        cards = _list_books(md, "smartedu")
        assert [b["book"] for b in cards] == [BOOK]
        assert cards[0]["kind"] == "cards"
        assert cards[0]["count"] == 2
        exams = _list_books(md, "zgkao")
        assert len(exams) == 1
        assert exams[0]["kind"] == "questions"

    def test_missing_dir(self):
        assert _list_books(Path("/nonexistent"), "all") == []


class TestWizardDefaults:
    """输入序列：来源 / 目录 / 卡片 / 模型 / 入库 / 确认（模型问题总是出现）。"""

    def test_all_defaults(self):
        argv, model_env = run_wizard(
            input_fn=_inputs(["", "", "", "", "", "", ""]),
            md_dir=None,
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        assert argv == ["--source", "all"]
        assert model_env is None

    def test_cancel_returns_none(self):
        result = run_wizard(
            input_fn=_inputs(["", "", "", "", "", "", "n"]),
            md_dir=None,
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        assert result is None


class TestWizardPartial:
    def test_partial_book_with_pages(self, tmp_path):
        md = _make_books(tmp_path)
        argv, model_env = run_wizard(
            input_fn=_inputs([
                "2",          # 来源：仅教材
                "n",          # 不提取目录
                "2",          # 部分提取
                "1",          # 选第 1 本
                "8-30",       # 页码
                "",           # 强制重做：默认否
                "",           # 模型：默认当前配置
                "3",          # 跳过入库
                "y",          # 确认
            ]),
            md_dir=md,
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        assert argv == ["--source", "smartedu", "--skip-toc",
                        "--book", BOOK, "--pages", "8-30", "--skip-load"]
        assert model_env is None

    def test_partial_exam_no_pages_question(self, tmp_path):
        md = _make_books(tmp_path)
        argv, _ = run_wizard(
            input_fn=_inputs([
                "3",          # 来源：仅试卷
                "2",          # 部分提取
                "1",          # 选试卷（唯一）
                "",           # 强制重做：默认否
                "",           # 模型：默认当前配置
                "",           # 入库：默认增量
                "y",          # 确认
            ]),
            md_dir=md,
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        # zgkao → 自动 skip-toc；试卷不问页码
        assert argv == ["--source", "zgkao", "--skip-toc",
                        "--book", "数学/初中/second/2024/数学-初三-模拟二-试卷"]

    def test_partial_no_books_falls_back_to_all(self, tmp_path):
        argv, _ = run_wizard(
            input_fn=_inputs([
                "2",          # 仅教材
                "",           # 提取目录
                "2",          # 部分提取 → 无书目，退化为全部
                "",           # 强制重做：默认否
                "",           # 模型：默认当前配置
                "",           # 入库：默认增量
                "y",          # 确认
            ]),
            md_dir=tmp_path / "empty-md",  # 不存在
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        assert argv == ["--source", "smartedu"]


class TestWizardModel:
    PROVIDERS = {
        "qwen": {"model": "qwen3.7-max", "base_url": "https://dashscope.aliyuncs.com/compatible-mode",
                 "api_key": "sk-qwen"},
    }

    def test_choose_other_provider(self):
        argv, model_env = run_wizard(
            input_fn=_inputs(["", "", "", "", "2", "", "", ""]),
            md_dir=None,
            current_provider="kimi",
            current_model="kimi-latest",
            providers=self.PROVIDERS,
        )
        assert argv == ["--source", "all"]
        assert model_env == {
            "LLM_PROVIDER": "qwen",
            "LLM_MODEL": "qwen3.7-max",
            "LLM_AUTH_TOKEN": "sk-qwen",
            "LLM_BASE_URL": "",  # deploy 默认 URL 规范化为空（用 per-provider 默认）
        }

    def test_choose_other_provider_custom_model(self):
        argv, model_env = run_wizard(
            input_fn=_inputs(["", "", "", "", "2", "qwen3.7-plus", "", ""]),
            md_dir=None,
            current_provider="kimi",
            current_model="kimi-latest",
            providers=self.PROVIDERS,
        )
        assert model_env["LLM_MODEL"] == "qwen3.7-plus"

    def test_keep_current(self):
        argv, model_env = run_wizard(
            input_fn=_inputs(["", "", "", "", "1", "", ""]),
            md_dir=None,
            current_provider="kimi",
            current_model="kimi-latest",
            providers=self.PROVIDERS,
        )
        assert model_env is None

    def test_no_current_provider_model_still_asked(self):
        """无当前配置时模型问题仍出现（选项 = 其他 provider + 手动输入）。"""
        argv, model_env = run_wizard(
            input_fn=_inputs(["", "", "", "", "1", "", "", ""]),
            md_dir=None,
            current_provider=None,
            providers=self.PROVIDERS,
        )
        assert argv == ["--source", "all"]
        assert model_env == {
            "LLM_PROVIDER": "qwen",
            "LLM_MODEL": "qwen3.7-max",
            "LLM_AUTH_TOKEN": "sk-qwen",
            "LLM_BASE_URL": "",
        }

    def test_manual_custom_model(self):
        """手动输入自定义模型（不在任何配置文件中）：provider/模型名/Key/BaseURL。"""
        # PROVIDER_CHOICES = (openai, kimi, qwen, glm, deepseek, gemini, local, anthropic)
        # 选项 = [当前配置, 手动输入]（providers 为空）→ 手动输入是 2
        argv, model_env = run_wizard(
            input_fn=_inputs([
                "", "", "",      # 来源/目录/卡片：默认
                "",              # 强制重做：默认否
                "2",             # 模型：手动输入
                "5",             # provider：deepseek
                "deepseek-v4",   # 模型名
                "sk-custom",     # API Key
                "",              # Base URL：回车 = 默认端点
                "", "",          # 入库默认 / 确认
            ]),
            md_dir=None,
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        assert model_env == {
            "LLM_PROVIDER": "deepseek",
            "LLM_MODEL": "deepseek-v4",
            "LLM_AUTH_TOKEN": "sk-custom",
            "LLM_BASE_URL": "",
        }

    def test_manual_local_requires_base_url(self):
        # local provider 必须给 Base URL：先给空（重问）再给有效值
        argv, model_env = run_wizard(
            input_fn=_inputs([
                "", "", "",          # 来源/目录/卡片
                "",                  # 强制重做：默认否
                "2",                 # 模型：手动输入
                "7",                 # provider：local
                "Qwen3.8-27B",       # 模型名
                "",                  # Key：local 可为空
                "",                  # Base URL：空 → 重问
                "http://192.168.1.8:12345/v1",
                "", "",              # 入库默认 / 确认
            ]),
            md_dir=None,
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        assert model_env == {
            "LLM_PROVIDER": "local",
            "LLM_MODEL": "Qwen3.8-27B",
            "LLM_AUTH_TOKEN": "",
            "LLM_BASE_URL": "http://192.168.1.8:12345/v1",
        }

    def test_manual_custom_model_with_base_url(self):
        argv, model_env = run_wizard(
            input_fn=_inputs([
                "", "", "",
                "",                          # 强制重做：默认否
                "2",                        # 手动输入
                "1",                        # provider：openai
                "gpt-4o",                   # 模型名
                "sk-xxx",                   # Key
                "https://my-proxy.local/v1",  # 自定义 Base URL
                "", "",
            ]),
            md_dir=None,
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        assert model_env["LLM_PROVIDER"] == "openai"
        assert model_env["LLM_BASE_URL"] == "https://my-proxy.local/v1"


class TestWizardReconvert:
    """强制重做：选是自动带 --reconvert（extract+publish 清 checkpoint 重跑）。"""

    def test_partial_redo_yes(self, tmp_path):
        md = _make_books(tmp_path)
        argv, _ = run_wizard(
            input_fn=_inputs([
                "2",          # 仅教材
                "",           # 提取目录
                "2",          # 部分提取
                "1",          # 选书
                "8-30",       # 页码
                "y",          # 强制重做
                "",           # 模型：默认
                "",           # 入库：默认
                "y",          # 确认
            ]),
            md_dir=md,
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        assert "--reconvert" in argv
        assert argv == ["--source", "smartedu", "--book", BOOK,
                        "--pages", "8-30", "--reconvert"]

    def test_all_extract_redo_yes(self):
        argv, _ = run_wizard(
            input_fn=_inputs(["", "", "", "y", "", "", ""]),
            md_dir=None,
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        assert argv == ["--source", "all", "--reconvert"]

    def test_redo_default_no(self):
        argv, _ = run_wizard(
            input_fn=_inputs(["", "", "", "", "", "", ""]),
            md_dir=None,
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        assert "--reconvert" not in argv

    def test_skip_extract_no_redo_question(self):
        """跳过卡片提取时不问重做（5 个输入即走完，多问会 EOF 报错）。"""
        argv, _ = run_wizard(
            input_fn=_inputs(["3", "3", "", "", "y"]),  # zgkao / 跳过卡片 / 模型 / 入库 / 确认
            md_dir=None,
            current_provider="kimi",
            current_model="kimi-latest",
            providers={},
        )
        assert argv == ["--source", "zgkao", "--skip-toc", "--skip-extract"]


class TestWizardLoadMode:
    def test_full_reload_confirmed(self):
        argv, _ = run_wizard(
            input_fn=_inputs(["", "", "", "", "", "2", "y", "y"]),
            md_dir=None, current_provider="kimi", current_model="m", providers={},
        )
        assert "--purge-business-data" in argv

    def test_full_reload_declined_falls_back(self):
        argv, _ = run_wizard(
            input_fn=_inputs(["", "", "", "", "", "2", "n", "y"]),
            md_dir=None, current_provider="kimi", current_model="m", providers={},
        )
        assert "--purge-business-data" not in argv
        assert "--load-cards" not in argv  # 增量是默认行为（不加参数）

    def test_dry_run_choice(self):
        argv, _ = run_wizard(
            input_fn=_inputs(["", "", "", "", "", "", "d"]),
            md_dir=None, current_provider="kimi", current_model="m", providers={},
        )
        assert argv == ["--source", "all", "--dry-run"]

    def test_skip_load(self):
        argv, _ = run_wizard(
            input_fn=_inputs(["", "", "", "", "", "3", "y"]),
            md_dir=None, current_provider="kimi", current_model="m", providers={},
        )
        assert "--skip-load" in argv
