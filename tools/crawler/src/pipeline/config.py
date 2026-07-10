"""Pipeline 配置加载。

支持的配置来源（优先级从高到低）：
1. 显式传入的参数
2. 环境变量
3. 默认值
"""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class PipelineConfig:
    data_dir: Path
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
    def from_env(cls, data_dir: str | None = None, output_dir: str | None = None) -> "PipelineConfig":
        cwd = Path(__file__).resolve().parents[3]
        return cls(
            data_dir=Path(data_dir or os.getenv("CRAWLER_DATA_DIR", str(cwd / "data"))),
            output_dir=Path(output_dir or os.getenv("CRAWLER_OUTPUT_DIR", str(cwd / "output"))),
            mineru_bin=os.getenv("MINERU_BIN", "mineru-open-api"),
            mineru_timeout=int(os.getenv("MINERU_TIMEOUT", "300")),
            llm_provider=os.getenv("LLM_PROVIDER", "openai"),
            llm_model=os.getenv("LLM_MODEL", "gpt-4o"),
            llm_api_key=os.getenv("OPENAI_API_KEY") or os.getenv("ANTHROPIC_API_KEY"),
            llm_base_url=os.getenv("LLM_BASE_URL"),
            llm_timeout=int(os.getenv("LLM_TIMEOUT", "120")),
            llm_max_retries=int(os.getenv("LLM_MAX_RETRIES", "3")),
        )
