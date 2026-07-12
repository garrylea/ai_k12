"""LLM 客户端封装，支持 OpenAI 与 Anthropic 两种 provider。"""

from dataclasses import dataclass


@dataclass
class LLMResponse:
    content: str
    prompt_tokens: int
    completion_tokens: int


class LLMClient:
    def __init__(self, provider: str = "openai", api_key: str | None = None,
                 auth_token: str | None = None, model: str = "",
                 base_url: str | None = None, timeout: int = 120,
                 max_tokens: int = 16384):
        self._provider = provider
        self._model = model
        self._max_tokens = max_tokens
        if provider == "anthropic":
            # Anthropic 官方用 api_key（x-api-key 头）；部分代理用 auth_token（Authorization: Bearer）。
            from anthropic import Anthropic
            kwargs: dict = {"base_url": base_url, "timeout": timeout}
            if auth_token:
                kwargs["auth_token"] = auth_token
            elif api_key:
                kwargs["api_key"] = api_key
            self._client = Anthropic(**kwargs)
        else:
            from openai import OpenAI
            self._client = OpenAI(api_key=api_key or "", base_url=base_url, timeout=timeout)

    def complete(self, system_prompt: str, user_prompt: str) -> LLMResponse:
        if self._provider == "anthropic":
            return self._complete_anthropic(system_prompt, user_prompt)
        return self._complete_openai(system_prompt, user_prompt)

    def _complete_openai(self, system_prompt: str, user_prompt: str) -> LLMResponse:
        response = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
        )
        return LLMResponse(
            content=response.choices[0].message.content or "{}",
            prompt_tokens=response.usage.prompt_tokens if response.usage else 0,
            completion_tokens=response.usage.completion_tokens if response.usage else 0,
        )

    def _complete_anthropic(self, system_prompt: str, user_prompt: str) -> LLMResponse:
        # Anthropic 无 json_object 模式；靠提示词约束 + extract._parse_json_object 兜底（去代码块、修转义）。
        response = self._client.messages.create(
            model=self._model,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
            max_tokens=self._max_tokens,
        )
        text = ""
        for block in response.content:
            if getattr(block, "type", None) == "text":
                text += block.text
        return LLMResponse(
            content=text or "{}",
            prompt_tokens=response.usage.input_tokens if response.usage else 0,
            completion_tokens=response.usage.output_tokens if response.usage else 0,
        )
