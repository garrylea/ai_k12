import json
from unittest.mock import MagicMock, patch

import pytest

from llm import (AnthropicCompatClient, DeepSeekClient, GLMClient, GeminiClient,
                 KimiClient, LLMClient, LLMResponse, LocalLlmClient, QwenClient,
                 REGISTRY, create_llm_client)


class TestFactoryDispatch:
    def test_registry_has_all_providers(self):
        assert set(REGISTRY) == {"kimi", "qwen", "glm", "deepseek",
                                 "gemini", "local", "anthropic"}

    def test_known_provider_returns_subclass(self):
        cases = {
            "kimi": KimiClient,
            "qwen": QwenClient,
            "glm": GLMClient,
            "deepseek": DeepSeekClient,
            "gemini": GeminiClient,
            "local": LocalLlmClient,
            "anthropic": AnthropicCompatClient,
            "openai": LLMClient,  # 默认回退 base
        }
        for provider, cls in cases.items():
            inst = create_llm_client(provider=provider, api_key="fake", model="m")
            assert isinstance(inst, cls), f"provider={provider} -> {type(inst).__name__}"

    def test_unknown_provider_falls_back_to_base(self):
        inst = create_llm_client(provider="not-a-provider", api_key="fake", model="m")
        assert isinstance(inst, LLMClient)


class TestThinkingParam:
    """各子类 thinking 开关 -> extra_body 参数映射。"""

    def _make(self, cls, **kw):
        return cls(api_key="fake", model="m", **kw)

    def test_kimi(self):
        c = self._make(KimiClient)
        assert c._thinking_param(True) == {"enable_thinking": True}
        assert c._thinking_param(False) == {"enable_thinking": False}

    def test_qwen(self):
        c = self._make(QwenClient)
        assert c._thinking_param(True) == {"enable_thinking": True, "thinking_budget": 8192}
        assert c._thinking_param(False) == {"enable_thinking": False}

    def test_glm(self):
        c = self._make(GLMClient)
        assert c._thinking_param(True) == {
            "thinking": {"type": "enabled", "budget_tokens": 8192}}
        assert c._thinking_param(False) == {}

    def test_deepseek(self):
        c = self._make(DeepSeekClient)
        assert c._thinking_param(True) == {"reasoning_effort": "medium"}
        assert c._thinking_param(False) == {}

    def test_deepseek_reasoner_model_switched_when_no_thinking(self):
        # deepseek-reasoner 恒思考：thinking=False 时内部切换为 deepseek-chat
        c = DeepSeekClient(api_key="fake", model="deepseek-reasoner")
        assert c._model == "deepseek-chat"
        c2 = DeepSeekClient(api_key="fake", model="deepseek-flash", thinking=True)
        assert c2._model == "deepseek-flash"  # 非 reasoner 不切换

    def test_gemini(self):
        c = self._make(GeminiClient)
        assert c._thinking_param(True) == {"thinking_config": {"thinking_budget": 8192}}
        assert c._thinking_param(False) == {"thinking_config": {"thinking_budget": 0}}

    def test_local_uses_chat_template_kwargs(self):
        c = self._make(LocalLlmClient)
        assert c._thinking_param(True) == {"chat_template_kwargs": {"enable_thinking": True}}
        assert c._thinking_param(False) == {"chat_template_kwargs": {"enable_thinking": False}}

    def test_base_returns_empty(self):
        c = self._make(LLMClient)
        assert c._thinking_param(True) == {}


class TestResponseFormat:
    def test_json_object_when_no_thinking(self):
        c = LLMClient(api_key="fake", model="m")
        assert c._response_format_param() == {"response_format": {"type": "json_object"}}

    def test_dropped_when_thinking(self):
        # thinking 开启时降级纯文本，避免 GBNF Grammar 与 <think> 标签冲突
        c = LLMClient(api_key="fake", model="m", thinking=True)
        assert c._response_format_param() is None


class TestComplete:
    def _mock_client(self, llm, content='{"items": []}'):
        mock = MagicMock()
        resp = MagicMock()
        resp.choices = [MagicMock(message=MagicMock(content=content))]
        resp.usage = MagicMock(prompt_tokens=10, completion_tokens=5)
        mock.chat.completions.create.return_value = resp
        llm._client = mock
        return mock

    def test_complete_parses_usage(self):
        llm = LLMClient(api_key="fake", model="gpt-4o")
        mock = self._mock_client(llm)
        resp = llm.complete("system", "user")
        assert resp.prompt_tokens == 10
        assert resp.completion_tokens == 5
        assert json.loads(resp.content) == {"items": []}

    def test_complete_handles_null_usage(self):
        llm = LLMClient(api_key="fake", model="gpt-4o")
        mock = MagicMock()
        resp = MagicMock()
        resp.choices = [MagicMock(message=MagicMock(content='{"items": []}'))]
        resp.usage = None
        mock.chat.completions.create.return_value = resp
        llm._client = mock
        resp = llm.complete("system", "user")
        assert resp.prompt_tokens == 0
        assert resp.completion_tokens == 0

    def test_think_block_stripped(self):
        # 本地/推理模型可能把 <think> 直接放进 content
        llm = LLMClient(api_key="fake", model="m")
        raw = '<think>先判断再输出</think>{"items": [{"n": 1}]}'
        self._mock_client(llm, content=raw)
        resp = llm.complete("system", "user")
        assert "<think>" not in resp.content
        assert json.loads(resp.content) == {"items": [{"n": 1}]}

    def test_extra_body_sent_when_thinking(self):
        llm = KimiClient(api_key="fake", model="m", thinking=True)
        mock = self._mock_client(llm)
        llm.complete("system", "user")
        kwargs = mock.chat.completions.create.call_args.kwargs
        assert kwargs["extra_body"] == {"enable_thinking": True}
        assert "response_format" not in kwargs  # thinking 时降级纯文本

    def test_bad_param_fallback_retries_without_extra_body(self):
        # 端点不支持 thinking/cache 参数 -> 400/422 -> 去掉参数重试一次
        class _BadRequest(Exception):
            status_code = 400

        llm = KimiClient(api_key="fake", model="m", thinking=True)
        mock = MagicMock()
        ok = MagicMock()
        ok.choices = [MagicMock(message=MagicMock(content='{"items": []}'))]
        ok.usage = None
        mock.chat.completions.create.side_effect = [_BadRequest("bad param"), ok]
        llm._client = mock
        resp = llm.complete("system", "user")
        assert mock.chat.completions.create.call_count == 2
        assert resp.content == '{"items": []}'
        # 第二次调用不带 extra_body
        assert "extra_body" not in mock.chat.completions.create.call_args.kwargs

    def test_non_param_error_not_swallowed(self):
        llm = LLMClient(api_key="fake", model="m", thinking=True)
        mock = MagicMock()
        mock.chat.completions.create.side_effect = RuntimeError("network down")
        llm._client = mock
        with pytest.raises(RuntimeError):
            llm.complete("system", "user")


class TestAnthropicCompat:
    def test_cache_control_on_system_when_enabled(self):
        with patch("anthropic.Anthropic") as mock_anthropic_cls:
            mock_client = MagicMock()
            mock_anthropic_cls.return_value = mock_client
            resp = MagicMock()
            resp.content = [MagicMock(type="text", text='{"ok": true}')]
            resp.usage = MagicMock(input_tokens=7, output_tokens=3)
            mock_client.messages.create.return_value = resp

            llm = AnthropicCompatClient(api_key="fake", model="m", enable_cache=True)
            out = llm.complete("system prompt", "user")

        kwargs = mock_client.messages.create.call_args.kwargs
        assert isinstance(kwargs["system"], list)
        assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}
        assert kwargs["system"][0]["text"] == "system prompt"
        assert "thinking" not in kwargs
        assert out.prompt_tokens == 7
        assert json.loads(out.content) == {"ok": True}

    def test_thinking_param_when_enabled(self):
        with patch("anthropic.Anthropic") as mock_anthropic_cls:
            mock_client = MagicMock()
            mock_anthropic_cls.return_value = mock_client
            resp = MagicMock()
            resp.content = [MagicMock(type="text", text="{}")]
            resp.usage = None
            mock_client.messages.create.return_value = resp

            llm = AnthropicCompatClient(api_key="fake", model="m", thinking=True)
            llm.complete("system", "user")

        kwargs = mock_client.messages.create.call_args.kwargs
        assert kwargs["thinking"] == {"type": "enabled", "budget_tokens": 8192}
