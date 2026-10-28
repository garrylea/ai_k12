"""学科名 ↔ subject code 的唯一定义（publish / extract / 答案提取共用）。

中文学科名是素材目录的第 1 段（如 ``语文/初中/second/...``）。新增学科时只改这里，
避免 publish_cli / question_extract / subject_cases 各存一份映射漂移。
"""

from pathlib import Path

# 中文学科名 -> subject code（与 tools/db/schema.sql 的 subjects.code 一致）
SUBJECT_NAME_TO_CODE: dict[str, str] = {
    "数学": "math", "语文": "chinese", "英语": "english",
    "物理": "physics", "化学": "chemistry", "生物": "biology",
    "历史": "history", "地理": "geography", "道德与法治": "politics",
}

# 识别不出学科时的回退（兼容历史资产路径，publish/extract 保持不变）
DEFAULT_SUBJECT_CODE = "math"


def subject_code_for_parts(rel_parts: tuple[str, ...] | list[str] | None,
                           default: str = DEFAULT_SUBJECT_CODE) -> str:
    """从相对路径分段的首段（中文学科名）推导 subject code。"""
    if rel_parts:
        return SUBJECT_NAME_TO_CODE.get(str(rel_parts[0]), default)
    return default


def subject_code_for_path(rel_path: Path, default: str = DEFAULT_SUBJECT_CODE) -> str:
    """从相对路径（Path）推导 subject code。"""
    return subject_code_for_parts(rel_path.parts, default=default)
