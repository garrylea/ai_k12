"""LLM 客户端封装：OpenAI 兼容 Base + 各 Provider 差异化子类。

架构：
- ``LLMClient`` 为 base，封装统一的 OpenAI 兼容调用（auth / base_url / model /
  timeout / max_tokens / max_retries / JSON mode / think 标签清洗 / 参数容错降级）。
- 各 provider 一个 subclass，仅覆盖 ``_thinking_param`` / ``_cache_param`` /
  ``_response_format_param`` 等 hook。
- ``create_llm_client()`` 显式工厂按 provider 字符串分发，未注册的 provider 回退 base。

调用方用法（构造签名与旧 ``LLMClient`` 一致）：

    from llm import create_llm_client
    llm = create_llm_client(provider="local", api_key="local_key",
                            model="Qwen3.8-27B", base_url="http://192.168.1.8:12345/v1")
"""

import re
from dataclasses import dataclass
from typing import Any, ClassVar


@dataclass
class LLMResponse:
    content: str
    prompt_tokens: int
    completion_tokens: int


class LLMClient:
    """OpenAI 兼容统一层。子类通过 hook 注入 provider 特有行为。"""

    provider: ClassVar[str] = "openai"
    default_base_url: ClassVar[str | None] = None
    default_timeout: ClassVar[int] = 120
    supports_json_object: ClassVar[bool] = True

    def __init__(self, provider: str = "openai", api_key: str | None = None,
                 auth_token: str | None = None, model: str = "",
                 base_url: str | None = None, timeout: int | None = None,
                 max_tokens: int = 16384, max_retries: int = 0,
                 thinking: bool = False, enable_cache: bool = False,
                 thinking_budget: int = 8192):
        self._provider = provider
        self._model = model
        self._max_tokens = max_tokens
        self._thinking = bool(thinking)
        self._enable_cache = bool(enable_cache)
        self._thinking_budget = thinking_budget
        self._max_retries = max_retries
        self._base_url = base_url or self.default_base_url
        self._timeout = timeout if timeout is not None else self.default_timeout
        self._api_key = api_key or ""
        self._auth_token = auth_token  # 仅 AnthropicCompat 使用；OpenAI 兼容统一用 api_key
        from openai import OpenAI
        self._client = OpenAI(
            api_key=self._api_key,
            base_url=self._base_url,
            timeout=self._timeout,
            max_retries=self._max_retries,
        )

    # ---- hook：子类覆盖 ----

    @property
    def model(self) -> str:
        """当前模型名（诊断日志用）。"""
        return self._model

    def _thinking_param(self, enable: bool) -> dict:
        """thinking 开关 -> extra_body 参数。默认不支持，返回空。"""
        return {}

    def _cache_param(self, enable: bool) -> dict:
        """显式缓存开关 -> extra_body 参数。默认走服务端自动前缀缓存，返回空。"""
        return {}

    def _response_format_param(self) -> dict | None:
        """JSON 模式参数。thinking 开启时返回 None（推理输出先于 JSON，
        llama.cpp GBNF Grammar 会与 <think> 标签冲突，需降级纯文本由下游解析）。"""
        if self._thinking or not self.supports_json_object:
            return None
        return {"response_format": {"type": "json_object"}}

    # ---- 请求组装与容错 ----

    def _build_kwargs(self, system_prompt: str, user_prompt: str) -> dict:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        extra: dict[str, Any] = {}
        extra.update(self._thinking_param(self._thinking))
        extra.update(self._cache_param(self._enable_cache))
        if extra:
            kwargs["extra_body"] = extra
        rf = self._response_format_param()
        if rf:
            kwargs.update(rf)
        return kwargs

    @staticmethod
    def _is_bad_param_error(e: Exception) -> bool:
        """判断是否因参数不受支持导致的 4xx/422（openai SDK 抛 APIStatusError）。"""
        status = getattr(e, "status_code", None)
        return status in (400, 422) or "BadRequest" in type(e).__name__

    @staticmethod
    def _clean_content(content: str | None) -> str:
        """剥离 <think>...</think> 块（本地/推理模型可能直接返回思考标签）。"""
        text = content or ""
        stripped = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
        return stripped.strip() or text

    def complete(self, system_prompt: str, user_prompt: str) -> LLMResponse:
        kwargs = self._build_kwargs(system_prompt, user_prompt)
        try:
            response = self._client.chat.completions.create(**kwargs)
        except Exception as e:
            # 容错降级：端点不支持 thinking/cache 参数（400/422）时，去掉后重试一次
            if (self._thinking or self._enable_cache) and self._is_bad_param_error(e):
                print(f"[llm] {self._provider}: 端点不支持 thinking/cache 参数（{e}），"
                      f"降级为无参数重试", flush=True)
                kwargs.pop("extra_body", None)
                response = self._client.chat.completions.create(**kwargs)
            else:
                raise
        return LLMResponse(
            content=self._clean_content(response.choices[0].message.content) or "{}",
            prompt_tokens=response.usage.prompt_tokens if response.usage else 0,
            completion_tokens=response.usage.completion_tokens if response.usage else 0,
        )


class KimiClient(LLMClient):
    """Moonshot（Kimi）。⚠️ enable_thinking 参数名与默认值联调时核实。"""

    provider = "kimi"
    default_base_url = "https://api.moonshot.cn/v1"

    def _thinking_param(self, enable: bool) -> dict:
        # kimi-k2 系列：enable_thinking 默认 True，显式 False 关闭
        return {"enable_thinking": enable}


class QwenClient(LLMClient):
    """阿里云百炼 DashScope 兼容模式。"""

    provider = "qwen"
    default_base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"

    def _thinking_param(self, enable: bool) -> dict:
        params = {"enable_thinking": enable}
        if enable and self._thinking_budget:
            params["thinking_budget"] = self._thinking_budget
        return params


class GLMClient(LLMClient):
    """智谱 GLM。⚠️ thinking 参数形态待核实；不支持的模型由 base 的 4xx 降级兜底。"""

    provider = "glm"
    default_base_url = "https://open.bigmodel.cn/api/paas/v4"

    def _thinking_param(self, enable: bool) -> dict:
        if enable:
            return {"thinking": {"type": "enabled", "budget_tokens": self._thinking_budget}}
        return {}


class DeepSeekClient(LLMClient):
    """DeepSeek。⚠️ 官方按模型区分思考：reasoner 恒思考，无法参数关闭。"""

    provider = "deepseek"
    default_base_url = "https://api.deepseek.com"

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        # thinking=False 时，reasoner 模型恒思考无法关闭 -> 内部切换为 chat 模型
        if not self._thinking and (
            self._model == "deepseek-reasoner" or self._model.startswith("deepseek-r")
        ):
            print(f"[llm] deepseek: {self._model} 恒开思考，thinking=False 时切换为 "
                  f"deepseek-chat", flush=True)
            self._model = "deepseek-chat"

    def _thinking_param(self, enable: bool) -> dict:
        # deepseek-chat（V3.2+）用 reasoning_effort 控制推理深度
        if enable:
            return {"reasoning_effort": "medium"}
        return {}


class GeminiClient(LLMClient):
    """Gemini OpenAI 兼容端点。⚠️ thinking_config 形态待核实。"""

    provider = "gemini"
    default_base_url = "https://generativelanguage.googleapis.com/v1beta/openai/"

    def _thinking_param(self, enable: bool) -> dict:
        # Gemini 2.5 系列默认思考；budget=0 关闭
        budget = self._thinking_budget if enable else 0
        return {"thinking_config": {"thinking_budget": budget}}


class LocalLlmClient(LLMClient):
    """本地 llama.cpp server（gemma / qwen 系列）。

    新版 llama-server 通过 Jinja 模板参数支持每请求 thinking 开关
    （Qwen3 模板认 ``chat_template_kwargs.enable_thinking``）；老版本不支持时由
    base 的 4xx 降级兜底。本地 27B 推理 TTFT 高，默认超时放宽到 300s。
    """

    provider = "local"
    default_timeout = 300
    default_base_url = None  # 由配置传入

    def _thinking_param(self, enable: bool) -> dict:
        return {"chat_template_kwargs": {"enable_thinking": enable}}


class AnthropicCompatClient(LLMClient):
    """Anthropic 兼容端点（DeepSeek / 智谱等厂商的 /anthropic 路径）。

    走 anthropic SDK，与 OpenAI 兼容路径独立；保留旧 LLMClient 的 anthropic 能力。
    """

    provider = "anthropic"

    def __init__(self, provider: str = "anthropic", api_key: str | None = None,
                 auth_token: str | None = None, model: str = "",
                 base_url: str | None = None, timeout: int | None = None,
                 max_tokens: int = 16384, max_retries: int = 0,
                 thinking: bool = False, enable_cache: bool = False,
                 thinking_budget: int = 8192):
        self._provider = provider
        self._model = model
        self._max_tokens = max_tokens
        self._thinking = bool(thinking)
        self._enable_cache = bool(enable_cache)
        self._thinking_budget = thinking_budget
        self._timeout = timeout if timeout is not None else self.default_timeout
        self._max_retries = max_retries
        from anthropic import Anthropic
        kwargs: dict[str, Any] = {"base_url": base_url, "timeout": self._timeout,
                                  "max_retries": self._max_retries}
        if auth_token:
            # 部分代理用 auth_token（Authorization: Bearer）；官方用 api_key（x-api-key）
            kwargs["auth_token"] = auth_token
        elif api_key:
            kwargs["api_key"] = api_key
        self._client = Anthropic(**kwargs)

    @property
    def model(self) -> str:
        """当前模型名（诊断日志用）。"""
        return self._model

    def complete(self, system_prompt: str, user_prompt: str) -> LLMResponse:
        system: str | list = system_prompt
        if self._enable_cache:
            # Anthropic 官方 prompt caching：system 块挂 cache_control
            system = [{"type": "text", "text": system_prompt,
                       "cache_control": {"type": "ephemeral"}}]
        kwargs: dict[str, Any] = {
            "model": self._model,
            "system": system,
            "messages": [{"role": "user", "content": user_prompt}],
            "max_tokens": self._max_tokens,
        }
        if self._thinking:
            kwargs["thinking"] = {"type": "enabled", "budget_tokens": self._thinking_budget}
        response = self._client.messages.create(**kwargs)
        text = ""
        for block in response.content:
            if getattr(block, "type", None) == "text":
                text += block.text
        return LLMResponse(
            content=self._clean_content(text) or "{}",
            prompt_tokens=response.usage.input_tokens if response.usage else 0,
            completion_tokens=response.usage.output_tokens if response.usage else 0,
        )


# provider 字符串 -> 子类 注册表（create_llm_client 分发用）
REGISTRY: dict[str, type[LLMClient]] = {
    "kimi": KimiClient,
    "qwen": QwenClient,
    "glm": GLMClient,
    "deepseek": DeepSeekClient,
    "gemini": GeminiClient,
    "local": LocalLlmClient,
    "anthropic": AnthropicCompatClient,
}


def create_llm_client(provider: str = "openai", **kwargs: Any) -> LLMClient:
    """工厂：按 provider 返回对应子类实例；未注册的 provider 回退 base（OpenAI 兼容）。"""
    cls = REGISTRY.get(provider, LLMClient)
    # 本地 llama.cpp server 不校验鉴权，但 OpenAI SDK 要求非空 api_key；
    # 未显式传 key 时补哑值，避免 "Missing credentials" 直接崩溃。
    if provider == "local" and not kwargs.get("api_key"):
        kwargs["api_key"] = "local_key"
    return cls(provider=provider, **kwargs)
