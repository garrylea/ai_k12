"""env_bootstrap：pipeline_cli 首次运行时的配置引导。

数据源是 deploy.sh 的产物：
  - apps/server/.env            各 provider 的 BASE_URL/API_KEY + DB_*
  - model-routes.yaml           各 provider 的模型名
  - tools/deploy/runtime/deploy.state.json   三者齐全的兜底来源

当 tools/data-refinery/.env 缺失/不完整时，让用户从已配置的 provider 中选择一个，
生成 refinery 专属 .env，后续运行不再询问。
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

module_dir = Path(__file__).resolve().parent   # …/tools/data-refinery/src
tool_dir = module_dir.parent                    # …/tools/data-refinery
project_root = tool_dir.parent.parent           # 仓库根（…/ai_k12；data-refinery → tools → 根）

REFINERY_ENV = tool_dir / ".env"
SERVER_ENV = project_root / "apps" / "server" / ".env"
MODEL_YAML = project_root / "apps" / "server" / "src" / "ai-core" / "model-routes.yaml"
DEPLOY_STATE = project_root / "tools" / "deploy" / "runtime" / "deploy.state.json"

PROVIDERS = ("kimi", "qwen", "gemini", "deepseek")
# model-routes.yaml 中各 provider 主模型块的 yaml key
# （与 tools/deploy/apply-llm-config.mjs 的 MODEL_KEY 对齐）
YAML_MAIN_KEY = {
    "kimi": "kimi",
    "qwen": "qwen3.7-max",
    "gemini": "gemini-3.1-pro",
    "deepseek": "deepseek-v4-flash",
}

# deploy.sh configure_llm_provider 的默认 Base URL（deploy.sh:313-316）。
# 与默认一致时写空值，让 llm.py 的 per-provider default_base_url 生效
# （默认 URL 常缺 /v1 等路径，直接写入会导致端点错误）。
DEPLOY_DEFAULT_URLS = {
    "kimi": "https://api.moonshot.cn",
    "qwen": "https://dashscope.aliyuncs.com/compatible-mode",
    "gemini": "https://generativelanguage.googleapis.com",
    "deepseek": "https://api.deepseek.com",
}

DB_DEFAULTS = {
    "DB_HOST": "localhost",
    "DB_PORT": "3306",
    "DB_USER": "ai_k12",
    "DB_PASS": "ai_k12",
    "DB_NAME": "ai_k12",
}


def _parse_env_file(path: Path) -> dict[str, str]:
    """行级 KEY=VALUE 解析（跳过注释/空行，去成对引号）。"""
    result: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            result[key] = value
    return result


def _parse_model_yaml(path: Path) -> dict[str, str]:
    """model-routes.yaml -> {provider: modelId}。

    主 key 优先（YAML_MAIN_KEY），否则取该 provider 的第一个 model 块。
    复刻 apply-llm-config.mjs 的按行扫描结构。
    """
    blocks: dict[str, list[tuple[str, str]]] = {}
    in_models = False
    current_key: str | None = None
    current_provider: str | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if re.match(r"^models:\s*$", line):
            in_models = True
            continue
        if not in_models:
            continue
        if re.match(r"^\S", line):  # 顶层其他键（routes:/default:）结束 models 块
            in_models = False
            continue
        m = re.match(r"^  (\S+):\s*$", line)  # 二级 model key
        if m:
            current_key = m.group(1)
            current_provider = None
            continue
        m = re.match(r"^    provider:\s*(\S+)\s*$", line)
        if m and current_key is not None:
            current_provider = m.group(1)
            continue
        m = re.match(r"^    modelId:\s*(\S+)\s*$", line)
        if m and current_key is not None and current_provider:
            blocks.setdefault(current_provider, []).append((current_key, m.group(1)))
            current_key = None
            current_provider = None
    result: dict[str, str] = {}
    for provider, entries in blocks.items():
        main_key = YAML_MAIN_KEY.get(provider)
        for key, model_id in entries:
            if key == main_key:
                result[provider] = model_id
                break
        else:
            result[provider] = entries[0][1]
    return result


def _normalize_base_url(provider: str, url: str) -> str:
    """与 deploy.sh 默认 URL 一致时返回空（用 llm.py 的 per-provider 默认端点），
    自定义地址（如自建代理，通常自带完整路径）原样保留。"""
    if not url:
        return ""
    default = DEPLOY_DEFAULT_URLS.get(provider, "")
    if default and url.rstrip("/") == default.rstrip("/"):
        return ""
    return url


def _collect_providers(server_env: dict[str, str], yaml_models: dict[str, str],
                      state: dict[str, str]) -> dict[str, dict]:
    """每 provider 的 model/base_url/api_key；server .env 优先，state 兜底，模型名 yaml 优先。"""
    providers: dict[str, dict] = {}
    for p in PROVIDERS:
        up = p.upper()
        providers[p] = {
            "model": yaml_models.get(p) or state.get(f"LLM_{up}_MODEL") or "",
            "base_url": server_env.get(f"{up}_BASE_URL") or state.get(f"LLM_{up}_BASE_URL") or "",
            "api_key": server_env.get(f"{up}_API_KEY") or state.get(f"LLM_{up}_API_KEY") or "",
        }
    return providers


def _refinery_env_configured(path: Path) -> bool:
    if not path.exists():
        return False
    env = _parse_env_file(path)
    return bool(env.get("LLM_PROVIDER") and env.get("LLM_MODEL")
                and (env.get("LLM_AUTH_TOKEN") or env.get("LLM_API_KEY")))


def _choose_provider(available: dict[str, dict], input_fn=input) -> str:
    names = list(available)
    print("=== 数据管线（切卡标注/题目提取）LLM 配置 ===")
    print("检测到 deploy.sh 已配置以下模型，请选择数据管线使用的 provider：")
    for i, p in enumerate(names, 1):
        info = available[p]
        print(f"  {i}) {p:<9} ({info['model']}, {info['base_url'] or '默认端点'})")
    while True:
        raw = str(input_fn(f"选择 [1-{len(names)}，默认 1]: ")).strip()
        if not raw:
            return names[0]
        if raw.isdigit() and 1 <= int(raw) <= len(names):
            return names[int(raw) - 1]
        if raw in names:
            return raw
        print(f"  无效选择：{raw}")


def _write_refinery_env(refinery_env: Path, provider: str, info: dict,
                        server_env: dict[str, str]) -> None:
    missing_db = [k for k in DB_DEFAULTS if not server_env.get(k)]
    if missing_db:
        print(f"[env-bootstrap] WARN: apps/server/.env 缺少 {'/'.join(missing_db)}，使用默认值",
              file=sys.stderr)
    db = {k: server_env.get(k) or v for k, v in DB_DEFAULTS.items()}
    base_url = _normalize_base_url(provider, info["base_url"])
    lines = [
        f"# Generated by pipeline_cli env bootstrap from apps/server/.env on "
        f"{datetime.now():%Y-%m-%d %H:%M:%S}",
        f"# provider 选择：{provider}（模型 {info['model']}）",
        "",
        "# MinerU（convert 阶段使用；pipeline 从 toc 开始，未配置不影响）",
        "MINERU_BIN=mineru-open-api",
        "MINERU_TIMEOUT=300",
        "MINERU_TOKEN=",
        "",
        "# LLM（数据管线：目录解析/切卡标注/题目提取共用）",
        f"LLM_PROVIDER={provider}",
        f"LLM_MODEL={info['model']}",
        f"LLM_AUTH_TOKEN={info['api_key']}",
        f"LLM_BASE_URL={base_url}",
        "LLM_TIMEOUT=120",
        "LLM_MAX_RETRIES=3",
        "LLM_MAX_TOKENS=16384",
        "LLM_THINKING=false",
        "LLM_ENABLE_CACHE=false",
        "",
        "# MySQL（与 apps/server 共库）",
    ]
    lines += [f"{k}={v}" for k, v in db.items()]
    refinery_env.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _apply_env(path: Path) -> None:
    """写入 .env 后重新加载到当前进程。

    config.py 在 import 时已 load_dotenv(override=False) 执行过一次，
    这里必须 override=True 才能让本进程的 RefineryConfig.from_env() 读到新配置。
    """
    load_dotenv(path, override=True)


def ensure_refinery_env(
    refinery_env: Path = REFINERY_ENV,
    server_env_path: Path = SERVER_ENV,
    yaml_path: Path = MODEL_YAML,
    state_path: Path = DEPLOY_STATE,
    input_fn=input,
) -> bool:
    """确保 tools/data-refinery/.env 配置完整；缺失时从 deploy 产物引导生成。

    返回 True 表示配置就绪（原本完整或本次生成）。无法引导时 SystemExit(1)。
    """
    if _refinery_env_configured(refinery_env):
        return True

    if not server_env_path.exists():
        print(
            "[env-bootstrap] 未找到 apps/server/.env —— 请先运行 tools/deploy.sh，\n"
            f"              或参照 tools/data-refinery/.env.example 手动配置 {refinery_env}",
            file=sys.stderr,
        )
        raise SystemExit(1)

    server_env = _parse_env_file(server_env_path)
    yaml_models = _parse_model_yaml(yaml_path) if yaml_path.exists() else {}
    state: dict[str, str] = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            state = {}

    providers = _collect_providers(server_env, yaml_models, state)
    available = {p: info for p, info in providers.items() if info["api_key"] and info["model"]}
    for p, info in providers.items():
        if p not in available:
            missing = [k for k in ("api_key", "model") if not info[k]]
            print(f"[env-bootstrap] 跳过 {p}（缺少 {'/'.join(missing)}）", file=sys.stderr)

    if not available:
        print(
            "[env-bootstrap] 没有任何 provider 配置完整（需要 API Key + 模型名），\n"
            "              请重新运行 tools/deploy.sh 或手动配置 " + str(refinery_env),
            file=sys.stderr,
        )
        raise SystemExit(1)

    chosen = os.environ.get("REFINERY_PROVIDER", "").strip().lower()
    if chosen:
        if chosen not in available:
            print(f"[env-bootstrap] REFINERY_PROVIDER={chosen} 未配置或不完整"
                  f"（可选：{', '.join(available)}）", file=sys.stderr)
            raise SystemExit(1)
    elif len(available) == 1:
        chosen = next(iter(available))
        print(f"[env-bootstrap] 仅一个可用 provider，自动选择 {chosen}")
    else:
        chosen = _choose_provider(available, input_fn=input_fn)

    _write_refinery_env(refinery_env, chosen, available[chosen], server_env)
    _apply_env(refinery_env)
    print(f"[env-bootstrap] 已生成 {refinery_env}（provider={chosen}, model={available[chosen]['model']}）")
    return True
