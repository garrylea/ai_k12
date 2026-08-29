"""pipeline_cli 的交互式向导：无参数运行时逐项收集执行选项。

流程：来源 → 目录提取（含强制重做）→ 卡片范围（全部/部分：选书 + 页码）→
LLM 模型（仅本次运行，不写 .env）→ 入库模式 → 执行计划确认。

返回 (argv, model_env)：
- argv：传给 pipeline_cli.main 的参数列表
- model_env：LLM 覆盖环境变量 dict（选了当前配置以外时非 None），
  在 main 解析参数前写入 os.environ，仅本次进程生效
- 取消时返回 None
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from env_bootstrap import (
    DEPLOY_STATE,
    MODEL_YAML,
    SERVER_ENV,
    _collect_providers,
    _normalize_base_url,
    _parse_env_file,
    _parse_model_yaml,
)
from markdown_scanner import MarkdownScanner

_PAGES_RE = re.compile(r"^[\d,\-\s]+$")


# ---------- 通用提问 ----------

def _ask_option(title: str, options: list[str], input_fn, default: int = 1,
                allow_empty: bool = True) -> int:
    """编号选择题，返回 1-based 序号。"""
    print(f"=== {title} ===")
    for i, opt in enumerate(options, 1):
        print(f"  {i}) {opt}")
    while True:
        raw = str(input_fn(f"选择 [{'回车' if allow_empty else '1'}={default}]: ")).strip()
        if not raw:
            if allow_empty:
                return default
            continue
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return int(raw)
        print(f"  无效选择：{raw}")


def _ask_bool(prompt: str, input_fn, default: bool = True) -> bool:
    raw = str(input_fn(f"{prompt} [{'Y/n' if default else 'y/N'}]: ")).strip().lower()
    if not raw:
        return default
    return raw in ("y", "yes", "是")


def _ask_pages(input_fn) -> str | None:
    """页码范围（如 8-30 或 8,12-20），回车 = 全部页。"""
    while True:
        raw = str(input_fn("页码范围（如 8-30 或 8,12-20，回车=全部页）: ")).strip()
        if not raw:
            return None
        if _PAGES_RE.match(raw):
            return raw
        print("  无效页码范围（只允许数字、逗号、连字符）")


# ---------- 书目列表 ----------

def _list_books(md_dir: Path, source: str) -> list[dict]:
    """扫描已转 MD 的书/试卷目录，按来源过滤。

    Returns: [{"book": rel_path, "kind": "cards"|"questions", "count": 文件数}]
    """
    if not md_dir or not md_dir.exists():
        return []
    books: dict[str, dict] = {}
    for s in MarkdownScanner(md_dir).scan():
        name = s.md_path.name
        is_exam = "试卷" in name or "答案" in name
        if source == "zgkao" and not is_exam:
            continue
        if source == "smartedu" and is_exam:
            continue
        key = s.rel_path.as_posix()
        b = books.setdefault(key, {"book": key, "kind": s.kind, "count": 0})
        b["count"] += 1
    return sorted(books.values(), key=lambda b: b["book"])


# ---------- 模型候选 ----------

def _available_providers() -> dict[str, dict]:
    """deploy 产物中的可用 provider（provider -> model/base_url/api_key）。"""
    server_env = _parse_env_file(SERVER_ENV) if SERVER_ENV.exists() else {}
    yaml_models = _parse_model_yaml(MODEL_YAML) if MODEL_YAML.exists() else {}
    state: dict = {}
    if DEPLOY_STATE.exists():
        try:
            state = json.loads(DEPLOY_STATE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            state = {}
    providers = _collect_providers(server_env, yaml_models, state)
    return {p: info for p, info in providers.items() if info["api_key"] and info["model"]}


# llm.py REGISTRY 支持的 provider（自定义模型输入用）
_PROVIDER_CHOICES = ("openai", "kimi", "qwen", "glm", "deepseek", "gemini", "local", "anthropic")


def _ask_custom_model(input_fn) -> dict:
    """手动输入自定义模型（不在任何配置文件中的模型）。"""
    p_idx = _ask_option("模型 provider", list(_PROVIDER_CHOICES), input_fn)
    provider = _PROVIDER_CHOICES[p_idx - 1]

    model = ""
    while not model:
        model = str(input_fn("模型名（必填）: ")).strip()
        if not model:
            print("  模型名不能为空")

    key = ""
    if provider == "local":
        key = str(input_fn("API Key / Token（回车=无需鉴权）: ")).strip()
    else:
        while not key:
            key = str(input_fn("API Key / Token（必填）: ")).strip()
            if not key:
                print("  不能为空")

    base_url = ""
    if provider == "local":
        # local 的 llama.cpp server 没有默认端点，必须显式给
        while not base_url:
            base_url = str(input_fn("Base URL（如 http://192.168.1.8:12345/v1，必填）: ")).strip()
            if not base_url:
                print("  local provider 必须提供 Base URL")
    else:
        base_url = str(input_fn("Base URL（回车=provider 默认端点）: ")).strip()

    return {"LLM_PROVIDER": provider, "LLM_MODEL": model,
            "LLM_AUTH_TOKEN": key, "LLM_BASE_URL": base_url}


# ---------- 向导主流程 ----------

def run_wizard(input_fn=input, md_dir: Path | None = None,
               current_provider: str | None = None,
               current_model: str | None = None,
               providers: dict[str, dict] | None = None) -> tuple[list[str], dict | None] | None:
    """交互式收集执行选项。

    Args:
        input_fn: 输入函数（默认 input，测试注入）
        md_dir: md 目录（列出可选书目）
        current_provider/current_model: 当前 .env 配置（菜单首项 + 默认）
        providers: 可选 provider 列表（默认从 deploy 产物收集；测试注入）

    Returns:
        (argv, model_env) 或 None（用户取消）。model_env 为 None 表示沿用当前配置。
    """
    argv: list[str] = []
    plan: list[str] = []

    # 1. 素材来源
    source_idx = _ask_option(
        "素材来源",
        ["全部（教材 + 试卷）", "仅教材（smartedu）", "仅试卷（zgkao）"],
        input_fn,
    )
    source = ["all", "smartedu", "zgkao"][source_idx - 1]
    argv += ["--source", source]
    plan.append(f"来源:   {source}")

    # 2. 目录提取（仅教材来源）
    book: dict | None = None
    pages: str | None = None
    if source in ("all", "smartedu"):
        gen_toc = _ask_bool("提取目录（toc_parse，教材前几页 → 章节结构）?", input_fn, default=True)
        if not gen_toc:
            argv.append("--skip-toc")
            plan.append("目录:   跳过")
        elif _ask_bool("强制重做已解析的目录?（忽略已解析记录，重新 LLM 解析；"
                       "作用域 = 后面选的书目或全部教材）", input_fn, default=False):
            argv.append("--reconvert-toc")
            plan.append("目录:   强制重做（重新解析）")
    else:
        argv.append("--skip-toc")
        plan.append("目录:   跳过（试卷无目录）")

    # 3. 卡片范围
    extract_idx = _ask_option(
        "卡片提取（extract，MD → 卡片 + LLM 标注）",
        ["全部提取", "部分提取（选书/试卷 + 页码）", "跳过"],
        input_fn,
    )
    if extract_idx == 3:
        argv.append("--skip-extract")
        plan.append("卡片:   跳过")
    elif extract_idx == 2:
        books = _list_books(md_dir, source)
        if not books:
            print("  （未找到已转 MD 的书目，退化为全部提取）")
            plan.append("卡片:   全部提取（无书目可选）")
        else:
            options = [f"[{'教材' if b['kind'] == 'cards' else '试卷'}] {b['book']}（{b['count']} 个文件）"
                       for b in books]
            book_idx = _ask_option("选择书目", options, input_fn)
            book = books[book_idx - 1]
            argv += ["--book", book["book"]]
            if book["kind"] == "cards":
                pages = _ask_pages(input_fn)
                if pages:
                    argv += ["--pages", pages]
            plan.append(f"卡片:   部分提取 — {book['book']}"
                        + (f"（页 {pages}）" if pages else ""))
    else:
        plan.append("卡片:   全部提取")

    # 3.5 强制重做：默认增量（已提取页跳过省 LLM 成本）；重做会清 checkpoint
    #     重新切割 + 标注 + 发布（仅 extract/publish，不动目录）
    if extract_idx != 3:
        if _ask_bool("强制重做已提取的页?（忽略已提取记录，重新切割 + LLM 标注 + 重新发布）",
                     input_fn, default=False):
            argv.append("--reconvert")
            plan[-1] += "，强制重做"

    # 4. LLM 模型（仅本次运行，不落盘）
    #    候选 = 当前 .env 配置 + deploy 产物中的其他 provider + 手动输入自定义模型
    model_env: dict | None = None
    if providers is None:
        providers = _available_providers()
    others = {p: info for p, info in providers.items() if p != current_provider}
    cur_desc = f"{current_provider} / {current_model or '(未知模型)'}（当前 .env 配置）" \
        if current_provider else None
    names = list(others)
    options = ([cur_desc] if cur_desc else []) \
        + [f"{p} / {others[p]['model']}" for p in names] \
        + ["手动输入自定义模型（provider / 模型名 / Key / Base URL）"]
    manual_idx = len(options)
    idx = _ask_option("LLM 模型（仅本次运行生效，不写入 .env）", options, input_fn)
    if idx == manual_idx:
        model_env = _ask_custom_model(input_fn)
        plan.append(f"模型:   {model_env['LLM_PROVIDER']} / {model_env['LLM_MODEL']}"
                    f"（自定义，本次运行生效）")
    elif cur_desc and idx == 1:
        plan.append(f"模型:   {cur_desc}")
    else:
        chosen = names[idx - (2 if cur_desc else 1)]
        info = others[chosen]
        raw_model = str(input_fn(f"  {chosen} 模型名 [{info['model']}]: ")).strip()
        model = raw_model or info["model"]
        model_env = {
            "LLM_PROVIDER": chosen,
            "LLM_MODEL": model,
            "LLM_AUTH_TOKEN": info["api_key"],
            "LLM_BASE_URL": _normalize_base_url(chosen, info["base_url"]),
        }
        plan.append(f"模型:   {chosen} / {model}（本次运行生效）")

    # 5. 入库模式
    load_idx = _ask_option(
        "数据入库（db_loader）",
        ["增量入库（默认，不清业务数据）",
         "全量重载（清空 answers/错题本/progress 等业务数据，不可恢复！）",
         "跳过入库"],
        input_fn,
    )
    if load_idx == 3:
        argv.append("--skip-load")
        plan.append("入库:   跳过")
    elif load_idx == 2:
        if _ask_bool("  !! 将清空学生侧业务数据（不可恢复），确认?", input_fn, default=False):
            argv.append("--purge-business-data")
            plan.append("入库:   全量重载（已确认清空业务数据）")
        else:
            print("  已回退为增量入库")
            plan.append("入库:   增量（全量重载未确认，回退）")
    else:
        plan.append("入库:   增量")

    # 6. 执行计划确认
    print("\n=== 执行计划 ===")
    for line in plan:
        print(f"  {line}")
    print("  发布:   是（publish，图片物化 + 路径改写）")
    while True:
        raw = str(input_fn("确认执行? [Y=执行 / d=仅试运行(dry-run) / n=取消]: ")).strip().lower()
        if raw in ("", "y", "yes"):
            return argv, model_env
        if raw == "d":
            return argv + ["--dry-run"], model_env
        if raw == "n":
            return None
        print("  请输入 Y / d / n")


# ---------- 模型覆盖应用 ----------

def apply_model_env(model_env: dict) -> None:
    """把向导选择的模型写入本进程环境变量（仅本次运行生效，不落盘）。

    各子 CLI 的 RefineryConfig.from_env() 运行时读 os.environ，先于阶段执行写入即可。
    """
    for key in ("LLM_PROVIDER", "LLM_MODEL", "LLM_AUTH_TOKEN", "LLM_BASE_URL"):
        if key in model_env:
            os.environ[key] = model_env[key]
