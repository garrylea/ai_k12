import os
from pathlib import Path

import pytest

from config import RefineryConfig


class TestRefineryConfig:
    def test_default_paths(self):
        config = RefineryConfig.from_env()
        assert config.input_dir.name == "data"
        assert config.output_dir.name == "output"

    def test_explicit_args_override_defaults(self, tmp_path):
        config = RefineryConfig.from_env(
            input_dir=str(tmp_path / "in"),
            output_dir=str(tmp_path / "out"),
        )
        assert config.input_dir == tmp_path / "in"
        assert config.output_dir == tmp_path / "out"

    def test_env_vars_override_defaults(self, monkeypatch, tmp_path):
        monkeypatch.setenv("REFINERY_INPUT_DIR", str(tmp_path / "env_input"))
        monkeypatch.setenv("REFINERY_OUTPUT_DIR", str(tmp_path / "env_output"))
        monkeypatch.setenv("MINERU_BIN", "custom-mineru")
        monkeypatch.setenv("MINERU_TIMEOUT", "600")
        monkeypatch.setenv("LLM_PROVIDER", "anthropic")
        monkeypatch.setenv("LLM_MODEL", "claude-3")
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        monkeypatch.setenv("LLM_BASE_URL", "https://api.example.com")
        monkeypatch.setenv("LLM_TIMEOUT", "60")
        monkeypatch.setenv("LLM_MAX_RETRIES", "5")

        config = RefineryConfig.from_env()
        assert config.input_dir == tmp_path / "env_input"
        assert config.output_dir == tmp_path / "env_output"
        assert config.mineru_bin == "custom-mineru"
        assert config.mineru_timeout == 600
        assert config.llm_provider == "anthropic"
        assert config.llm_model == "claude-3"
        assert config.llm_api_key == "sk-test"
        assert config.llm_base_url == "https://api.example.com"
        assert config.llm_timeout == 60
        assert config.llm_max_retries == 5

    def test_api_key_falls_back_to_anthropic(self, monkeypatch):
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-key")
        config = RefineryConfig.from_env()
        assert config.llm_api_key == "anthropic-key"
