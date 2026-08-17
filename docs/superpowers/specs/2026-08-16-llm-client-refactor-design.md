# LLM 客户端多 Provider 重构设计（Base + Subclass）

**日期**：2026-08-16  
**关联**：data-refinery 管线（`tools/data-refinery/src/llm.py`）  
**背景**：现有 `LLMClient` 只区分 openai/anthropic 两条路径，无 thinking / 缓存差异化处理；实际使用中需对接多 provider（kimi、qwen、glm、deepseek、gemini、本地 llama.cpp），各家的 thinking 开关与缓存机制不同。

---

## 1. 背景与问题

1. **无 thinking 控制**：`_complete_openai` / `_complete_anthropic` 都不带 thinking 参数。Anthropic 路径默认关（opt-in）；OpenAI 兼容路径下 thinking 开关取决于服务商默认值，无法按任务控制（标注/提取类 JSON 任务开 thinking 慢且费 token）。
2. **无显式缓存控制**：全代码无 `cache_prompt` / `cache_control`。系统提示词（`textbook_cards.txt`、`toc_parse.txt` 等）恒定且较长，是缓存的最佳场景。
3. **provider 逻辑耦合在单类内**：新增 provider 需改 `complete()` 内部分支，难以维护。

## 2. 目标

- 抽出一个 **Base class** 封装统一的 OpenAI 兼容调用（auth / base_url / model / timeout / max_tokens / retries / JSON mode）。
- 每个 provider 一个 **subclass**，仅覆盖两处 hook：`_thinking_param(enable)`、`_cache_param(enable)`。
- 兼容现有调用点与测试（`LLMClient(...)` 构造签名不变，按 provider 字符串自动分发）。

## 3. 已确认决策

1. 全部走 **OpenAI 兼容接口**；现有 Anthropic SDK 路径**保留为第七个子类** `AnthropicCompatClient`（当前 .env 走 DeepSeek anthropic 端点）。
2. thinking **默认关、可开**：base 默认 `thinking=False`，subclass 负责映射到各家参数，调用方/配置可开启。
3. **显式 cache 开关**：新增 `enable_cache` 参数，subclass 内映射；OpenAI 兼容官方端点大多有自动前缀缓存，开关对它们是 no-op，主要作用于 AnthropicCompat 的 `cache_control` 与中转场景。
4. 本地模型：llama.cpp 服务器 `http://192.168.1.8:12345`，模型 `Qwen3.8-27B`，key `local_key`。

## 4. 架构

```
LLMClient（base，OpenAI 兼容统一层）
├── KimiClient            # Moonshot（api.moonshot.cn）
├── QwenClient            # DashScope 兼容模式
├── GLMClient             # 智谱
├── DeepSeekClient        # deepseek
├── GeminiClient          # OpenAI 兼容端点
├── LocalLlmClient        # llama.cpp（本地 gemma / qwen）
└── AnthropicCompatClient # 保留现有 anthropic SDK 路径
```

### 4.1 Base class 职责

- 构造：`provider` / `api_key` / `model` / `base_url` / `timeout` / `max_tokens` / `max_retries`（透传进 `openai` SDK）/ `thinking=False` / `enable_cache=False` / `thinking_budget`。
- `complete(system_prompt, user_prompt) -> LLMResponse`：
  1. 组装 messages（system + user）
  2. 调 `_thinking_param` / `_cache_param` hook 合并 provider 特有参数到 `extra_body`
  3. `_response_format_param()` hook 决定是否带 `response_format={"type": "json_object"}`（thinking 开启时降级为纯文本，见 §5.2）
  4. 输出经 `_clean_content()` 剥离 `<think>...</think>` 块
  5. **容错降级**：thinking/cache 参数引发 4xx/422 时，去掉这些参数重试一次
- **显式工厂分发**（不用 `__new__`，避免类型推导混乱与重复初始化）：
  - `create_llm_client(provider, **kwargs)` 按 `REGISTRY` 返回子类实例；`provider="openai"`（默认）或未注册 provider 返回 base 实例。

### 4.2 Subclass hook 约定

- `_thinking_param(enable: bool) -> dict`：thinking 开关 → extra_body 键值。
- `_cache_param(enable: bool) -> dict`：显式缓存开关 → extra_body 键值 / Anthropic 侧 cache_control。
- `_response_format_param() -> dict | None`：JSON 模式参数；默认 `{"response_format": {"type": "json_object"}}`，thinking 开启时返回 `None`。

### 4.2 Subclass hook 约定

- `_thinking_param(enable: bool) -> dict`：thinking 开关 → extra_body 键值。
- `_cache_param(enable: bool) -> dict`：显式缓存开关 → extra_body 键值 / Anthropic 侧 cache_control。

## 5. 各 Provider 参数映射

> ⚠️ 标注项为按经验实现的假设，联调时需按各家最新文档核实。

| 子类 | thinking 关→开 | 显式缓存（enable_cache=true） |
|---|---|---|
| Kimi | ⚠️ `extra_body={"enable_thinking": false/true}` | 自动缓存，不传参 |
| Qwen | `extra_body={"enable_thinking": false/true}`（可加 `thinking_budget`） | 自动缓存，不传参 |
| GLM | ⚠️ 开→`extra_body={"thinking": {...}}`；关→不传 | 自动缓存，不传参 |
| DeepSeek | ⚠️ 开→`extra_body={"reasoning_effort": "medium"}`；关→不传（reasoner 模型恒思考，见 §5.4） | 自动缓存（磁盘前缀缓存），不传参 |
| Gemini | ⚠️ 开→`extra_body={"thinking_config": {"thinking_budget": N}}`；关→`thinking_budget=0` | 自动缓存，不传参 |
| Local(llama.cpp) | `extra_body={"chat_template_kwargs": {"enable_thinking": enable}}`（新版 llama-server 每请求支持；老版本由 4xx 降级兜底） | 服务端 prompt cache，不传参 |
| AnthropicCompat | 开→`messages.create(thinking={"type": "enabled", "budget_tokens": N})`；关→不传 | 开→system 块挂 `cache_control: {"type": "ephemeral"}` |

### 5.1 缓存说明

OpenAI 兼容端点大多具备**自动前缀缓存**（OpenAI、DeepSeek、DashScope、Moonshot 等），无需请求参数，且恒定 system prompt 前缀天然命中。因此：

- 官方端点：`enable_cache` 为 no-op，缓存仍自动生效。
- 中转类端点（若认 `cache_prompt`）：可在对应 subclass 的 `_cache_param` 中返回 `{"cache_prompt": true}`。
- AnthropicCompat：`enable_cache=true` 时在 system 块挂 `cache_control`。

### 5.2 JSON 模式与 thinking 的冲突（重点）

llama.cpp 收到 `response_format={"type": "json_object"}` 会启用 GBNF Grammar 强制输出以 `{` 开头；若本地模型先输出 `<think>` 思考标签，会被 Grammar 截断或导致采样器异常。云端推理模型同理（推理链先于 JSON）。

规则（base 统一处理）：
- `thinking=False`：正常带 `response_format={"type": "json_object"}`。
- `thinking=True`：**降级为纯文本输出**，由下游 `_parse_json_object`（extract.py）从文本中提取 JSON。
- `_response_format_param()` 为可 override hook，特殊端点可另行覆盖。

### 5.3 `<think>` 标签泄漏防护

若服务端未配置 reasoning parser，thinking 模式下模型会把 `<think>...</think>` 直接放在 `message.content`，导致 `json.loads` 直接失败。防护双层：
1. base `complete()` 内 `_clean_content()` 剥离 `<think>...</think>` 块；
2. `extract._parse_json_object` 解析前同样剥离（防御任何路径进来的污染）。

### 5.4 DeepSeek 官方端点按模型区分思考

DeepSeek 官方 API 通过模型名区分：`deepseek-reasoner` 恒开思考（无法用参数关闭），`deepseek-chat`（V3.2+）支持 `reasoning_effort` 控制深度。处理：
- `thinking=False` 且模型为 reasoner（`deepseek-reasoner` / `deepseek-r*`）时，客户端内部切换为 `deepseek-chat` 并打印提示；
- `thinking=True` 时对 chat 类模型传 `reasoning_effort="medium"`。

### 5.5 本地推理超时与并发

- 本地 27B 模型 TTFT 高，`LocalLlmClient` 默认 `timeout=300s`（覆盖 base 的 120s）。
- 当前管线为逐页串行调用，无并发问题；若未来引入并发且本地为单 slot，需限制并发避免排队导致客户端超时重试雪崩（本设计不实现，仅记录）。

### 5.6 参数容错（GLM 等未知参数防护）

各 provider 的 thinking/cache 参数形态在不同模型版本间可能变化，传不支持的 key 会 400/422。base `complete()` 捕获此类错误后**去掉 thinking/cache 参数重试一次**并打印告警，避免整页失败。

## 6. 配置与调用点改动

- `src/config.py` 新增字段：
  - `llm_thinking: bool`（env `LLM_THINKING`，默认 false）
  - `llm_enable_cache: bool`（env `LLM_ENABLE_CACHE`，默认 false）
  - `llm_max_retries`（已存在，此前未使用，现在透传进 SDK）
- 三个调用点追加传参：`extract_cli.py`、`toc_parse_cli.py`、`backfill_practice_questions.py`：
  `thinking=config.llm_thinking, enable_cache=config.llm_enable_cache`。
- 本地模型配置示例（`.env`）：
  ```
  LLM_PROVIDER=local
  LLM_BASE_URL=http://192.168.1.8:12345/v1
  LLM_MODEL=Qwen3.8-27B
  LLM_API_KEY=local_key
  ```

## 7. 向后兼容

- `LLMClient(provider="openai", ...)` 仍返回 base 实例；现有测试 `tests/test_llm.py`、`test_labeler_single_card.py` 的构造方式不变。
- 新增 `thinking` / `enable_cache` / `max_retries` 为可选参数，不传则用默认值。
- 调用点改用显式工厂 `create_llm_client(...)`（不再直接实例化 `LLMClient`），tests 中 `patch("extract_cli.LLMClient")` 改为 `patch("extract_cli.create_llm_client")`。

## 8. 测试

- `tests/test_llm.py`：
  - 工厂分发：`create_llm_client(provider="kimi"/"qwen"/"glm"/"deepseek"/"gemini"/"local"/"anthropic"/"openai")` 返回对应类实例。
  - thinking 映射：各 subclass `_thinking_param(True/False)` 的返回值断言（含 Local 的 `chat_template_kwargs`）。
  - cache 映射：AnthropicCompat `enable_cache=true` 时请求含 cache_control。
  - think 块剥离：`complete()` 返回的 content 无 `<think>` 块。
  - `complete()` 的 usage 解析（沿用现有用例）。

## 9. 待确认项（联调前需核实）

1. Kimi `enable_thinking` 参数名与默认值。
2. GLM thinking 参数形态（extra_body `thinking` vs 独立 thinking 模型）。
3. DeepSeek `reasoning_effort` 对 deepseek-chat / deepseek-v4-flash 的支持范围。
4. Gemini OpenAI 兼容端点 `thinking_config` 形态。
5. llama.cpp server 版本对 `chat_template_kwargs` / `reasoning_budget` 的支持程度。
