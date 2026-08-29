"""Data Refinery 配置加载。

支持的配置来源（优先级从高到低）：
1. 显式传入的参数
2. 环境变量
3. 默认值
"""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


module_dir = Path(__file__).resolve().parent
tool_dir = module_dir.parent
load_dotenv(tool_dir / ".env", override=False)


def _env_bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).strip().lower() in ("1", "true", "yes", "on")


@dataclass
class RefineryConfig:
    input_dir: Path
    output_dir: Path
    mineru_bin: str
    mineru_timeout: int
    mineru_token: str | None
    llm_provider: str
    llm_model: str
    llm_api_key: str | None
    llm_auth_token: str | None
    llm_base_url: str | None
    llm_timeout: int
    llm_max_retries: int
    llm_max_tokens: int
    llm_thinking: bool
    llm_enable_cache: bool
    llm_fallback_provider: str | None
    llm_fallback_model: str
    llm_fallback_api_key: str | None
    llm_fallback_base_url: str | None
    db_host: str
    db_port: int
    db_user: str
    db_pass: str
    db_name: str

    @classmethod
    def from_env(cls, input_dir: str | None = None, output_dir: str | None = None) -> "RefineryConfig":
        project_tools = tool_dir.parent
        return cls(
            input_dir=Path(input_dir or os.getenv("REFINERY_INPUT_DIR", str(project_tools / "crawler" / "data"))),
            output_dir=Path(output_dir or os.getenv("REFINERY_OUTPUT_DIR", str(tool_dir / "output"))),
            mineru_bin=os.getenv("MINERU_BIN", "mineru-open-api"),
            mineru_timeout=int(os.getenv("MINERU_TIMEOUT", "300")),
            mineru_token=os.getenv("MINERU_TOKEN"),
            llm_provider=os.getenv("LLM_PROVIDER", "openai"),
            llm_model=os.getenv("LLM_MODEL", "gpt-4o"),
            llm_api_key=os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY") or os.getenv("ANTHROPIC_API_KEY"),
            # 优先用 refinery 专属变量，避免被 shell 里 Claude Code 的 ANTHROPIC_AUTH_TOKEN 覆盖
            llm_auth_token=os.getenv("LLM_AUTH_TOKEN") or os.getenv("ANTHROPIC_AUTH_TOKEN"),
            llm_base_url=os.getenv("LLM_BASE_URL") or os.getenv("ANTHROPIC_BASE_URL"),
            llm_timeout=int(os.getenv("LLM_TIMEOUT", "120")),
            llm_max_retries=int(os.getenv("LLM_MAX_RETRIES", "3")),
            llm_max_tokens=int(os.getenv("LLM_MAX_TOKENS", "16384")),
            llm_thinking=_env_bool("LLM_THINKING"),
            llm_enable_cache=_env_bool("LLM_ENABLE_CACHE"),
            # 标注兜底模型：card_type 非法且主模型重试仍失败时切换（如 deepseek）
            llm_fallback_provider=os.getenv("LLM_FALLBACK_PROVIDER") or None,
            llm_fallback_model=os.getenv("LLM_FALLBACK_MODEL", ""),
            llm_fallback_api_key=os.getenv("LLM_FALLBACK_API_KEY"),
            llm_fallback_base_url=os.getenv("LLM_FALLBACK_BASE_URL"),
            db_host=os.getenv("DB_HOST", "localhost"),
            db_port=int(os.getenv("DB_PORT", "3306")),
            db_user=os.getenv("DB_USER", "ai_k12"),
            db_pass=os.getenv("DB_PASS", ""),
            db_name=os.getenv("DB_NAME", "ai_k12"),
        )
