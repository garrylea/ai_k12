import json
from unittest.mock import MagicMock

from llm import LLMClient


def test_complete_parses_usage():
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.choices = [MagicMock(message=MagicMock(content='{"items": []}'))]
    mock_response.usage = MagicMock(prompt_tokens=10, completion_tokens=5)
    mock_client.chat.completions.create.return_value = mock_response

    llm = LLMClient(api_key="fake", model="gpt-4o")
    llm._client = mock_client

    resp = llm.complete("system", "user")
    assert resp.prompt_tokens == 10
    assert resp.completion_tokens == 5
    assert json.loads(resp.content) == {"items": []}


def test_complete_handles_null_usage():
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.choices = [MagicMock(message=MagicMock(content='{"items": []}'))]
    mock_response.usage = None
    mock_client.chat.completions.create.return_value = mock_response

    llm = LLMClient(api_key="fake", model="gpt-4o")
    llm._client = mock_client

    resp = llm.complete("system", "user")
    assert resp.prompt_tokens == 0
    assert resp.completion_tokens == 0
