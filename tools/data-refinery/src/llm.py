"""LLM 客户端封装，当前支持 OpenAI。"""

from dataclasses import dataclass

from openai import OpenAI


@dataclass
class LLMResponse:
    content: str
    prompt_tokens: int
    completion_tokens: int


class LLMClient:
    def __init__(self, api_key: str, model: str, base_url: str | None = None, timeout: int = 120):
        self._client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)
        self._model = model

    def complete(self, system_prompt: str, user_prompt: str) -> LLMResponse:
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
