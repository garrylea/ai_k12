"""教材版式档案：把「学科相关」的版面识别规则收敛到一处。

背景：MinerU 转出的 MD 里，目录行与页眉/页脚残留的形态**因学科而异**——数学是
「3 第二十一章 一元二次方程」「第N章 X 页码」，语文是「1 沁园春·雪/毛泽东 3」
「60 | 阅读 | 第三单元」。原先这两条规则分别硬编码在 card_splitter 与 toc_parse_cli 里，
只能服务数学：实测 toc_parse_cli 对语文完全失效（只认出目录首页 page_004，
丢掉第三单元与课外古诗词诵读）。

本模块用「基类 + 每学科实现 + 注册表」承载，调用方按 subject 取用。
数学实现**逐字保留**原正则，保证行为零变化（见 tests/test_textbook_profile.py
的黄金回归：pattern 快照 + 手工用例 + 494 行真实教材冻结语料）。
"""

from __future__ import annotations

import re
from pathlib import Path


class TextbookProfile:
    """一个学科的版面规则。基类只给保守的通用规则，**不猜学科专属形态**。"""

    name = "generic"

    #: 通用目录行：行末为 1-3 位数字（学科可在此基础上叠加）
    _TOC_TAIL_RE = re.compile(r"\d{1,3}\s*$")

    def is_toc_line(self, line: str) -> bool:
        """该行是否像目录条目（标题 + 行末页码）。"""
        return bool(self._TOC_TAIL_RE.search(line.strip()))

    def is_page_furniture(self, line: str) -> bool:
        """该行是否为页眉/页脚残留。基类不猜学科形态，一律 False。"""
        return False


class MathTextbookProfile(TextbookProfile):
    """数学教材。两条正则与重构前**逐字一致**（见 test_textbook_profile 黄金回归）。

    - 目录行：``第N章 X 页码`` / ``N.M X 页码`` / ``小结|复习题|数学活动|阅读与思考 … 页码``
    - 页眉页脚残留（页码标注）：如 ``3 第二十一章 一元二次方程``
    """

    name = "math"

    _TOC_LINE_RE = re.compile(
        r'^\s*(第[一二三四五六七八九十百零]+章.*\d+\s*$'      # 第N章 X 页码
        r'|\d+\.\d+.*\d+\s*$'                                # N.M X 页码
        r'|.*(小结|复习题|数学活动|阅读与思考).*\d+\s*$)'       # 非编号条目+页码
    )
    # 页码标注：如 "3 第二十一章 一元二次方程"，是页眉/页脚残留，非正文内容
    _PAGE_NUMBER_HEADER_RE = re.compile(r'^\d+\s+第[一二三四五六七八九十百零]+章\s+\S+.*$')

    def is_toc_line(self, line: str) -> bool:
        return bool(self._TOC_LINE_RE.search(line))

    def is_page_furniture(self, line: str) -> bool:
        return bool(self._PAGE_NUMBER_HEADER_RE.match(line.strip()))


class ChineseTextbookProfile(TextbookProfile):
    """语文教材。形态由九上目录页（page_004–007）与版面实测推导（spec §4.1/§4.2）。

    - 目录行两种形态：行末 1-3 位页码（``1 沁园春·雪/毛泽东 3``、
      ``课外古诗词诵读 159``）或「篇名/作者」而无页码（``月夜忆舍弟/杜甫``）。
      后者必须计入：``课外古诗词诵读`` 下的诗题行都没有页码，
      否则 page_007 的匹配率不足 30% 会被误判为非目录页。
    - 页眉页脚残留：实测全书仅两种形态，各出现 1 次（page_067 页脚
      ``60 | 阅读 | 第三单元``、page_170 书尾 ``九年级 | 上册``），
      共同特征是「页码或年级 + 竖线」开头，故按前缀判定；markdown 表格行以
      ``|`` 开头、不匹配此前缀，不会被误删。
    """

    name = "chinese"

    #: 行末 1-3 位数字：课文行「1 沁园春·雪/毛泽东 3」、栏目行「课外古诗词诵读 159」
    _TOC_TAIL_RE = re.compile(r"\d{1,3}\s*$")
    #: 篇名/作者形式（「月夜忆舍弟/杜甫」）——无页码的诗题行靠这个特征计入
    _TITLE_AUTHOR_RE = re.compile(r"[/／]")
    #: 页码/年级 + 竖线 的页眉页脚（实测全书仅 2 行，属兜底）
    _PAGE_FURNITURE_RE = re.compile(r"^\s*(?:\d{1,3}|[一二三四五六七八九十]+年级)\s*[|｜]")

    def is_toc_line(self, line: str) -> bool:
        s = line.strip()
        if not s:
            return False
        return bool(self._TOC_TAIL_RE.search(s) or self._TITLE_AUTHOR_RE.search(s))

    def is_page_furniture(self, line: str) -> bool:
        return bool(self._PAGE_FURNITURE_RE.match(line))


_PROFILES: dict[str, type[TextbookProfile]] = {
    "math": MathTextbookProfile,
    "chinese": ChineseTextbookProfile,
    "generic": TextbookProfile,
}
_ALIASES: dict[str, str] = {
    "数学": "math", "语文": "chinese", "英语": "generic",
    "math": "math", "chinese": "chinese", "english": "generic",
}


def get_profile(subject: str | None) -> TextbookProfile:
    """按学科取版式档案；未注册学科（含 None）回退保守的基类。

    subject 可传中文名（``语文``/``数学``）或学科码（``chinese``/``math``）。
    """
    key = _ALIASES.get((subject or "").strip())
    return _PROFILES[key]() if key else TextbookProfile()


def profile_for_md_path(md_path: Path) -> TextbookProfile:
    """从 MD 路径推学科（路径首段即学科目录，如 `语文/初中/…`）。

    **推不出学科时回退数学档**——这是刻意为之的兼容默认：重构不得改变既有调用方的行为，
    而既有调用方（教材卡路径 ``extract_cli`` 经 ``card_splitter``、以及 ``toc_parse_cli``）
    服务的是数学。试卷切题走 ``question_splitter``/``question_extract``，不经过本模块。
    已登记为 ``generic`` 的学科（英语）同样走到这个回退。
    """
    for part in Path(md_path).parts:
        key = _ALIASES.get(part.strip())
        if key and key != "generic":
            return _PROFILES[key]()
    return MathTextbookProfile()
