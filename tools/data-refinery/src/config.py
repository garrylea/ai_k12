"""Data Refinery 配置加载。

支持的配置来源（优先级从高到低）：
1. 显式传入的参数
2. 环境变量
3. 默认值
"""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class RefineryConfig:
    input_dir: Path
    output_dir: Path
    mineru_bin: str
    mineru_timeout: int
    llm_provider: str
    llm_model: str
    llm_api_key: str | None
    llm_base_url: str | None
    llm_timeout: int
    llm_max_retries: int

    @classmethod
    def from_env(cls, input_dir: str | None = None, output_dir: str | None = None) -> "RefineryConfig":
        module_dir = Path(__file__).resolve().parent
        tool_dir = module_dir.parent
        project_tools = tool_dir.parent
        return cls(
            input_dir=Path(input_dir or os.getenv("REFINERY_INPUT_DIR", str(project_tools / "crawler" / "data"))),
            output_dir=Path(output_dir or os.getenv("REFINERY_OUTPUT_DIR", str(tool_dir / "output"))),
            mineru_bin=os.getenv("MINERU_BIN", "mineru-open-api"),
            mineru_timeout=int(os.getenv("MINERU_TIMEOUT", "300")),
            llm_provider=os.getenv("LLM_PROVIDER", "openai"),
            llm_model=os.getenv("LLM_MODEL", "gpt-4o"),
            llm_api_key=os.getenv("OPENAI_API_KEY") or os.getenv("ANTHROPIC_API_KEY"),
            llm_base_url=os.getenv("LLM_BASE_URL"),
            llm_timeout=int(os.getenv("LLM_TIMEOUT", "120")),
            llm_max_retries=int(os.getenv("LLM_MAX_RETRIES", "3")),
        )
