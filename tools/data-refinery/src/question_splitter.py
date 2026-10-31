"""试卷题切分器：按题号切分 + 答案对齐（统一扫描算法）。

与教材卡的 card_splitter（按 400 字贪心合并）不同，试卷题按题号切分，
题干原文原封不动，保留所有图片引用。详见
docs/superpowers/specs/2026-09-05-exam-question-splitter-design.md。
"""

import re
from dataclasses import dataclass
from pathlib import Path

# 主题号（行首）：1-2 位数字 + . + 非数字字符（不要求空格，兼容 9.xxx / 9. xxx / 9.$...$），
# 或 + 4 位年份+中文（'6.2025年...'，. 后是年份数字仍算题号），或 + :（'21: 在...' 冒号格式）。
# 仍排除小数（9.5）与 4 位日期（2026.5）。
# 语文参考答案段常用全角句点（'1．C（2 分）'），故分隔符含 ．(U+FF0E) / ：(U+FF1A)。
_MAIN_STEM_RE = re.compile(
    # 允许 markdown 标题前缀：MinerU 常把题号行识别成 `## 2. 甲组同学推荐…`
    # `(?![ \t]+\d)` 排除子题号被空格拆开的形态（`1.1 材料` → `1. 1 材料`），
    # 否则同一道题会被切成题1 两次（昌平一中 2024 实测）。
    # 但只挡 1-2 位且后面不再接数字的情况：`12. 2024 年…`（题12 正文以年份开头）
    # 会被裸的 `\d` 误挡，整题被上一题吞掉（西城北京四中 2024 期中实测）。
    r'^\s*#{0,6}\s*(\d{1,2})[.．](?![ \t]+\d{1,2}(?![0-9]))(?:\D|(?:19|20)\d{2}\s*[年月])'
    r'|^\s*#{0,6}\s*(\d{1,2})[:：]\s*\S'
    # '8（1）转朱阁…'：题号后直接跟小问号，OCR 丢了点。语文默写题常见。
    r'|^\s*#{0,6}\s*(\d{1,2})\s*[（(]\s*\d{1,2}\s*[）)](?=\s*\S)'
)
# 主题号前缀剥离：只消费 ^\s*\d{1,2}[.:．：]，不消费其后内容字符（避免无空格格式 '9.若' 丢首字）
# 另支持 '8（1）…'：只剥题号 8，保留小问号（由 is_sub_stem 继续处理）
# 以及 `## 2. …`：MinerU 会把题号行识别成 markdown 标题
_STEM_PREFIX_RE = re.compile(
    r'^\s*#{0,6}\s*\d{1,2}[.:．：]'
    r'|^\s*#{0,6}\s*\d{1,2}(?=\s*[（(]\s*\d{1,2}\s*[）)])'
)
# 紧凑格式（行内，答案区一行多题号）：(?<!\d) 防止把 19.5 的小数点误切
_INLINE_STEM_RE = re.compile(r'(?<!\d)(\d{1,2})[.．]\D')
# 题干区行内粘连的下一题：句末标点 + 题号 + 内容（'…楼房。16.根据…'）
_GLUED_STEM_RE = re.compile(r'[。；！？]\s*(\d{1,2})[.．]\s*(?=[^\d\s])')
# 小问号：行首 (N) 或（N）
_SUB_STEM_RE = re.compile(r'^\s*[\(（](\d{1,2})[\)）]')
# 大题分组标题：行首可选 markdown # 前缀 + 中文序号 + 、（兼容 "## 一、选择题"）
_GROUP_HEADER_RE = re.compile(r'^#{0,6}\s*([一二三四五六七八九十]+)、')
# 卷内部分标题：'## 第一部分 选择题' / '## 第二部分 非选择题'（关闭当前题，不进 content）
_PART_HEADER_RE = re.compile(r'^#{0,6}\s*第[一二三四五六七八九十]+部分\s*[:：]?\s*(\S*)')
# 疑似题号的小数/年份行：'数字.数字' 开头（题号+年份 '6.2025年' 或小数 '9.5'）——
# 选择题区里靠前瞻判定是否题号（见 _has_next_stem）
_AMBIGUOUS_NUM_RE = re.compile(r'^\s*(\d{1,2})\.\d')
# 日期/页码陷阱：行首 4 位数字 + . + 数字（如 2026.5）
_DATE_TRAP_RE = re.compile(r'^\s*\d{4}\.\d')
# 答案关键字（行内搜索）
# 答案关键字（行内搜索）：不匹配单独的"答案"（"试题答案"会误匹配），
# 只匹配"参考答案"/"答案及评分"/"评分参考"等标题特征
# 答案段入口：总标题「参考答案 / 评分参考」，或逐题「6.答案：…」。
# 后者没有总标题（和平街一中 2024 直接从「6..答案：」开始），只认总标题会把
# 整段答案当成题目切出来（38 题、题9 内容只剩「C（2分）」）。
# **不能**收裸的「答案：」——阅读材料里的问答（昌平一中 2024「跑步知识问答」
# 的「答案: 这是一种…」）会被误判成答案区入口，题14 之后整段消失。
_ANSWER_KEYWORD_RE = re.compile(
    r'参考答案|答案及评分|评分参考'
    r'|^\s*#{0,6}\s*\d{1,2}[.．]{1,2}\s*答案[：:]'
)
# 行内粘连的大题标题（OCR 把下一节标题并在上一题题干末尾）：
# '16.…（100 字左右）四、现代文阅读（共 23分）' -> 题干去掉尾部标题，后续题归「四」
_INLINE_GROUP_RE = re.compile(
    r'[（(]?\s*([一二三四五六七八九十]{1,3})、([^。；\n]{2,20}?)[（(]共?\s*\d+\s*分[）)]\s*$')
# 子小节标题：（一）（共 6 分）/ ## （二）（共 10 分）——材料归属的边界
_SECTION_HEADER_RE = re.compile(r'^#{0,6}\s*[（(]\s*[一二三四五六七八九十]+\s*[）)]')
# 卷首考试说明：`1. 本试卷共9页…` / `2. 在试卷和答题卡上…`。它们带有序号，
# 会被 is_main_stem 当成题1/2，之后真题再建一次 → 同卷两道题1，入库互相覆盖。
_NOTICE_RE = re.compile(
    r'本试卷|答题[卡纸]|机读卡|考试时间|考试结束|满分|共\s*\d+\s*页|准考证|班级'
)

# 材料块标题：材料一 / 材料 1 / ## 材料二
_MATERIAL_HEAD_RE = re.compile(r'^#{0,6}\s*材料\s*[一二三四五六七八九十\d]')


def is_date_trap(line: str) -> bool:
    """行首是否为日期/页码格式（如 2026.5），不当题号。"""
    return bool(_DATE_TRAP_RE.match(line))


def is_group_header(line: str) -> tuple[bool, str | None]:
    """行首是否为大题分组标题（如 '三、解答题'）。返回 (是否, 组号)。"""
    m = _GROUP_HEADER_RE.match(line)
    if m:
        return True, m.group(1)
    return False, None


def is_part_header(line: str) -> tuple[bool, str | None]:
    """行首是否为卷内部分标题（如 '## 第二部分 非选择题'）。

    返回 (是否, 部分类型)：'choice'（选择题）/ 'non_choice'（非选择题）/
    None（标题没带类型，如 '第3部分'）。部分标题是大分区（选择/非选择题），
    不是大题分组：命中时关闭当前题、丢弃该行，不改变 group_id/分数状态
    （大题分组由后续 '一、选择题' 决定）。部分类型供状态机判定「选择题区」
    （选择题区里行首 '数字.数字' 大概率是题号而非小数）。
    """
    m = _PART_HEADER_RE.match(line)
    if m:
        tail = m.group(1)
        if "选择" in tail:
            return True, "choice"
        if "填空" in tail or "解答" in tail or "判断" in tail or "计算" in tail:
            return True, "non_choice"
        return True, None
    return False, None


def is_main_stem(line: str) -> tuple[bool, int | None]:
    """行首是否为主题号（如 '9.' '9. ' '9.$...$' '6.2025年' '21: 在...'）。

    排除 4 位年份（2026.5，见 is_date_trap）和纯小数（9.5，. 后数字非年份）。
    返回 (是否, 题号 N)。
    """
    m = _MAIN_STEM_RE.match(line)
    if m:
        return True, int(m.group(1) or m.group(2) or m.group(3))
    return False, None


def _has_next_stem(lines: list[str], start: int, n: int,
                   is_stem=is_main_stem) -> bool:
    """lines[start:] 里（答案区/下一部分标题前）是否有比 n 更大的下一主题号。

    状态机判定用：选择题区行首 '数字.数字'（如 '6.2025年' 或小数 '9.5'），
    若后续能找到下一题号（'7.'/'7:' 等 >6 的行），则当前行是题号而非小数。
    扫描在答案关键字/部分标题/大分组标题前停止（那些不是题干续行）。

    `is_stem` 与主循环用同一个学科策略谓词（默认 `is_main_stem`）——题号规则
    一旦分科，「下一行是不是新题」必须跟着同一套规则判，否则策略只改一半。
    """
    for j in range(start, len(lines)):
        line = lines[j].strip()
        if not line:
            continue
        if is_answer_keyword(line) or is_part_header(line)[0] or is_group_header(line)[0]:
            return False
        if is_date_trap(line):
            continue
        ok, stem_no = is_stem(line)
        if ok and stem_no is not None and stem_no > n:
            return True
        # 该行是题干续行（非题号），继续找
    return False


def is_sub_stem(line: str) -> bool:
    """行首是否为小问号（如 '(1)' '（2）'）。"""
    return bool(_SUB_STEM_RE.match(line))


def is_answer_keyword(line: str) -> bool:
    """行内是否含答案关键字（参考答案/答案/评分参考）。"""
    return bool(_ANSWER_KEYWORD_RE.search(line))


def split_inline_stems(line: str) -> list[tuple[int, str]]:
    """紧凑格式：一行多题号（答案区 '9. xxx 10. yyy 11. zzz'）。

    返回 [(题号 N, 答案文本), ...]。无匹配返回空列表。

    含 LaTeX 环境的行（\\begin{ / \\end{）不匹配（'x - 2. \\end{array}' 的 '2.'
    会被误当作题号）。含解答题标志（解：/证明：/∵/∴/\\therefore/\\because）
    的行也跳过——它们是展开格式，行内 LaTeX 小数 'b=2.' 不能当题号。
    """
    if '\\begin{' in line or '\\end{' in line:
        return []
    if '![](' in line:  # 图片引用行：文件名里的 'a3.jpg' 会误匹配为题号 3
        return []
    if re.search(r'解[：:]|证明[：:]|∵|∴|\\therefore|\\because', line):
        return []
    matches = list(_INLINE_STEM_RE.finditer(line))
    if not matches:
        return []
    results: list[tuple[int, str]] = []
    for i, m in enumerate(matches):
        n = int(m.group(1))
        # 答案文本从 . 后的 \D 字符开始（包含该字符），到下一题号起点前
        start = m.end() - 1  # 回退到 \D 字符位置
        end = matches[i + 1].start() if i + 1 < len(matches) else len(line)
        text = line[start:end].strip()
        results.append((n, text))
    return results


def _split_glued_next_stem(line: str, expected: int) -> tuple[str, int, str] | None:
    """题干区一行内粘连的下一题：``…6层以下楼房。16.根据材料三…``。

    MinerU 偶尔把选项行与下一题题干合成一行，行首匹配找不到 16，整段被吞进
    上一题的选项 D（大兴 2024 题15/16 实测）。只有题号正好等于「上一题+1」
    才拆——卷首「考试时间150分钟。2.在试卷…」那时还没有 current，调用方不会进来。
    """
    for m in _GLUED_STEM_RE.finditer(line):
        if int(m.group(1)) != expected:
            continue
        tail = line[m.end():].strip()
        if tail:
            return line[: m.start() + 1], expected, tail
    return None


def parse_group_scores(header: str) -> tuple[str, object | None]:
    """解析分组标题的每题分数。

    返回 (kind, value)：
    - ('unified', N)：组内每题统一 N 分（选择题/填空题 '每题2分'）
    - ('map', {题号: 分数})：逐题给分（解答题 '第17-19题每题5分,第20题6分'）
    - ('none', None)：标题没给分数（如 '解答题(共78分)'）

    兼容全/半角括号、逗号，'第A-B题' 范围展开。
    """
    if re.search(r'第[\d-]+题', header):
        result: dict[int, int] = {}
        for nums, score in re.findall(r'第([\d-]+)题[^0-9]*?(\d+)\s*分', header):
            score = int(score)
            if '-' in nums:
                a, b = nums.split('-')
                result.update({n: score for n in range(int(a), int(b) + 1)})
            else:
                result[int(nums)] = score
        return ('map', result) if result else ('none', None)
    m = re.search(r'每题\s*(\d+)\s*分', header)
    if m:
        return ('unified', int(m.group(1)))
    return ('none', None)


# 选项标记：(A)/(a)/（A）/（a）
_OPTION_MARK_RE = re.compile(r'[\(（]([A-Da-d])[\)）]')
# 裸字母行内标记：'A. 文本'（点后须有内容）。前导不可是英文/数字（排除 '△ABC.'、'1A.' 之类），
# 但允许紧跟中文标点或括号（语文卷常见 '…的一项是(2分)A.呼之欲出 B.恰到好处'，无空格）。
_BARE_INLINE_RE = re.compile(r'(?<![A-Za-z0-9])([A-D])[.．](?=\s*\S)')
# 裸字母竖排行：行首单独 'A' / 'A.' / 'A、'（选项内容/配图在标记行之间）
_BARE_LINE_RE = re.compile(r'^\s*([A-D])\s*[.、．]?\s*$')


def _find_option_marks(content: str) -> list[tuple[int, int, str]] | None:
    """找连续的 A,B,C,D 选项标记序列（括号式优先，裸字母式兜底）。

    返回 4 个 (start, end, label)（content 内绝对偏移），找不到返回 None。
    两种标记体系分开找（同一题不会混用括号式与裸字母式）：
    - 括号式 (A)(B)(C)(D)：全/半角括号均兼容
    - 裸字母式 'A. x B. y'（行内）或 'A' 单独成行（竖排，配图在标记行间）
    """
    for pattern in (_OPTION_MARK_RE, _BARE_INLINE_RE):
        matches = list(pattern.finditer(content))
        for i, m in enumerate(matches):
            if m.group(1).upper() == 'A' and i + 3 < len(matches):
                seq = [matches[j].group(1).upper() for j in range(i, i + 4)]
                if seq == ['A', 'B', 'C', 'D']:
                    return [(m.start(), m.end(), m.group(1).upper())
                            for m in matches[i:i + 4]]
    # 竖排裸字母：行级匹配（_BARE_INLINE_RE 匹配不到无点或行尾的标记）
    # 标记 span 取整行（判别「纯标记行」用：行内除标记无其他内容）
    line_marks: list[tuple[int, int, str]] = []  # (start_offset, end_offset, label)
    offset = 0
    for line in content.split('\n'):
        m = _BARE_LINE_RE.match(line)
        if m:
            line_marks.append((offset, offset + len(line), m.group(1)))
        offset += len(line) + 1
    for i in range(len(line_marks) - 3):
        if [mk[2] for mk in line_marks[i:i + 4]] == ['A', 'B', 'C', 'D']:
            return line_marks[i:i + 4]
    return None


def _line_bounds(content: str) -> list[tuple[int, int]]:
    """每行在 content 中的 (start, end) 偏移（不含换行符）。"""
    bounds: list[tuple[int, int]] = []
    off = 0
    for line in content.split('\n'):
        bounds.append((off, off + len(line)))
        off += len(line) + 1
    return bounds


def _line_of(bounds: list[tuple[int, int]], pos: int) -> int:
    """pos 所在行号。"""
    for i, (s, e) in enumerate(bounds):
        if s <= pos <= e:
            return i
    return len(bounds) - 1


def _first_image_line_above(lines: list[str], li: int) -> int | None:
    """li 行上方最近的图片行号（向上扫描到第一个图片行为止）；没有返回 None。"""
    for j in range(li - 1, -1, -1):
        if lines[j].strip().startswith('!['):
            return j
    return None


def split_options(content: str) -> tuple[str, list[dict] | None]:
    """通用 A–D 拆分（所有走 generic 的学科共用；语文走 ChineseStrategy）。

    必须找到连续 A,B,C,D 四个标记才能拆；语文的甲乙丙丁 / ①②③ / 3–6 项
    规则在 `subject_strategies/chinese.py`，不在这里。

    content 里找连续的 A,B,C,D 选项标记序列（括号式 (A)(B)(C)(D) 或裸字母式
    'A. x B. y' / 竖排 'A' 单独成行）：
    - 找到：题干 = 第一个标记前的内容（+ 行内布局时末标记行后的尾部内容），
      options = 4 个 {label, text}
    - 找不到（非选择题或格式不符）：返回 (原 content, None)

    布局按标记分布判别：
    - 行内布局（4 个标记同一行，如西城模拟二 题3「题干+选项一行+图片下一行」）：
      (D) 文本止于所在行行尾，行后的尾部内容（题干配图等）整体归题干，
      D 行尾的 '[图]' 占位符一并剥掉（MinerU 的图片位置标记）
    - 跨行布局 + 内容在标记上方（图选项标准排版：字母标在图/内容下方，
      MinerU 线性化为 '图[+说明]\\nA\\n图\\nB\\n...\\nD'，标记独占行且 D 后
      无内容）：B/C/D 取上一标记行与本标记行之间的所有行；A 取其上方最近的
      图片行到 A 行之间的内容，更早的图归题干
    - 跨行布局（默认，标记在上、内容/图在标记行之间，如 'A.\\n图\\nB.\\n图'）：
      选项 = 标记间内容；若 A/B/C 三段都不含图（选项同构无图），D 行后的
      尾部内容（题干配图等）归题干、D 只取本行剩余，否则 D 取到 content 末尾
      （自配图不被截走归题干）
    """
    marks = _find_option_marks(content)
    if not marks:
        return content, None
    a_start, _, _ = marks[0]
    d_start, d_end, _ = marks[3]
    if '\n' not in content[a_start:d_end]:
        # 行内布局：D 止于所在行行尾，尾部内容（题干配图等）归题干
        d_line_end = content.find('\n', d_end)
        if d_line_end == -1:
            d_line_end = len(content)
        trailing = content[d_line_end:].strip()
        stem = content[:a_start].strip()
        if trailing:
            stem = (stem + "\n" + trailing) if stem else trailing
        d_text = re.sub(r'\s*\[图\]\s*$', '', content[d_end:d_line_end])
        opts: list[dict] = []
        for j in range(4):
            if j == 3:
                text = d_text
            else:
                text = content[marks[j][1]:marks[j + 1][0]]
            opts.append({"label": marks[j][2], "text": text.strip()})
        return stem, opts

    # 跨行布局
    lines = content.split('\n')
    bounds = _line_bounds(content)
    mark_line = [_line_of(bounds, m[0]) for m in marks]
    d_line = mark_line[3]
    d_rest = content[d_end:bounds[d_line][1]].strip()      # D 行内剩余
    after_d = '\n'.join(lines[d_line + 1:]).strip()        # D 行之后
    # 纯标记行：行内除标记外无其他内容（'A'/'A.'/'(A)' 独占一行；
    # '(A) 30°' 或行内 'A. x' 不算——那是标记在上内容在下的排版）
    def _pure(k: int) -> bool:
        s, _ = bounds[mark_line[k]]
        line = lines[mark_line[k]]
        rest = (line[:marks[k][0] - s] + line[marks[k][1] - s:]).strip()
        return not rest

    if all(_pure(k) for k in range(4)) and not d_rest and not after_d:
        # 内容在标记上方（图选项标准排版：字母标在图/内容下方，MinerU 线性化
        # 为 '内容\nA\n内容\nB\n...\nD'，D 后无内容）：
        # B/C/D 取上一标记行与本标记行之间的所有行；A 取其上方最近的图片行
        # 到 A 行之间的内容（更早的图归题干；无图则退化为 stem 全取）
        a_img = _first_image_line_above(lines, mark_line[0])
        if a_img is not None:
            stem = '\n'.join(lines[:a_img]).strip()
            a_text = '\n'.join(lines[a_img:mark_line[0]]).strip()
        else:
            stem = ''
            a_text = '\n'.join(lines[:mark_line[0]]).strip()
        opts = [{"label": marks[0][2], "text": a_text}]
        for k in range(1, 4):
            seg = '\n'.join(lines[mark_line[k - 1] + 1:mark_line[k]]).strip()
            opts.append({"label": marks[k][2], "text": seg})
        return stem, opts

    # 默认（标记在上、内容/图在标记行之间，如 'A.\n图\nB.\n图'）：
    # 选项 = 标记间内容，D 取到末尾（自配图不被截走）
    #
    # 题内上下文修正（方案 B）：若 A/B/C 三段都不含图片引用 ![](，
    # 则 D 行之后的尾部内容（题干配图等）不应归 D 而归题干——选项同构
    # （A/B/C 都没图，D 凭空有图不合常理）。修复海淀2026 模拟二 题1
    # 类排版：'(A) 圆柱 (B) 圆锥\n(C) 三棱柱 (D) 长方体\n\n![](图1)\n\n![](图2)'
    # 否则保持原行为（各选项自配图，D 自配图不被截走）。
    stem = content[:a_start].strip()
    # 先算 A/B/C 三段文本，判定是否含图
    abc_texts = [content[marks[j][1]:marks[j + 1][0]] for j in range(3)]
    abc_has_image = any('![](' in t for t in abc_texts)
    if not abc_has_image and after_d:
        # A/B/C 都没图 + D 行后有尾部内容 → 尾部归题干，D 只吃本行剩余（d_rest）
        stem = (stem + "\n" + after_d) if stem else after_d
        d_text = d_rest
    else:
        # 默认：D 取到末尾（自配图不被截走）
        d_text = content[d_end:]
    opts: list[dict] = []
    for j in range(4):
        if j == 3:
            text = d_text
        else:
            text = content[marks[j][1]:marks[j + 1][0]]
        opts.append({"label": marks[j][2], "text": text.strip()})
    return stem, opts


def parse_answer_table(line: str) -> dict[int, str]:
    """解析 HTML 表格提取选择题答案（题号→答案）。

    真实试卷选择题答案常在表格里：
    <table><tr><td>题号</td><td>1</td>...<td>8</td></tr>
           <tr><td>答案</td><td>A</td>...<td>D</td></tr></table>
    """
    import re as _re
    rows = _re.findall(r'<tr>(.*?)</tr>', line, _re.DOTALL)
    if len(rows) < 2:
        return {}
    header = _re.findall(r'<td[^>]*>(.*?)</td>', rows[0], _re.DOTALL)
    answer_row = _re.findall(r'<td[^>]*>(.*?)</td>', rows[1], _re.DOTALL)
    result: dict[int, str] = {}
    for i in range(1, min(len(header), len(answer_row))):
        try:
            n = int(header[i].strip())
            result[n] = answer_row[i].strip()
        except ValueError:
            continue
    return result


@dataclass
class RawQuestion:
    """切分后的原始题（answer/explanation 由答案对齐阶段填入）。"""
    group_order: int                # 题号 N（主题号）
    group_id: str | None            # 大题分组（"一"/"二"/"三"...），无分组为 None
    content: str                    # 题干原文（主题号"N."已剥离，小问号"(N)"保留）
    answer: str = ""                # 答案（答案对齐阶段填入）
    explanation: str | None = None  # 解析（答案对齐阶段填入）
    score: int | None = None        # 每题满分（分组标题解析），无则为 None
    material_text: str | None = None  # 同节共享材料（策略的 material_policy 开启时填）


def _strip_main_stem_prefix(line: str) -> str:
    """剥离行首主题号 'N.' 前缀，保留剩余内容（不消费 . 后的内容字符）。

    '9. 若代数式' -> '若代数式'
    '9.若代数式' -> '若代数式'
    '9. $\\frac{1}{x-3}$' -> '$\\frac{1}{x-3}$'
    """
    return _STEM_PREFIX_RE.sub('', line, count=1).strip()


def _strip_answer_prefix(text: str) -> str:
    """剥离答案文本开头的'解：'/'证明：'等前缀，只留内容。"""
    return re.sub(r'^\s*(解|证明|原式|原不等式组)[：:]\s*', '', text.strip())


def split_inline_group_header(text: str) -> tuple[str, str | None]:
    """拆出行尾粘连的大题标题。

    语文/OCR 常把下一节标题并在上一题题干末尾：
    '…（100 字左右）四、现代文阅读（共 23分）' -> ('…（100 字左右）', '四')
    无匹配返回 (原文, None)。
    """
    m = _INLINE_GROUP_RE.search(text)
    if not m:
        return text, None
    return text[:m.start()].rstrip(), m.group(1)


# 卷首/卷尾非题目文字：Ocr 常把「试卷说明」的第 N 条或卷尾署名切成一道题，
# 占掉一个真实题号（北师大实验 2024 期中：命题人那行占用了题 4）。
_JUNK_QUESTION_RE = re.compile(r"命题人|审核人|校对人|命题学校|第\s*\d+\s*页\s*共|共\s*\d+\s*页")


def is_junk_question(q: RawQuestion) -> bool:
    """这条"题"其实是卷首页脚/署名，不是题目。

    判据全部满足才算：内容很短、没有任何选项/答案/材料、命中页脚关键词、
    且不带 (1)(2) 这类小问（真实验题即使短也有小问）。
    """
    text = (q.content or "").strip()
    if not text or len(text) > 60:
        return False
    if getattr(q, "material_text", None):
        return False
    if not _JUNK_QUESTION_RE.search(text):
        return False
    if re.search(r"[（(]\s*1\s*[）)]", text):
        return False
    # 带问号/「下列」「正确」的是真题目，即使短也不丢
    if re.search(r"[？?]", text) or re.search(r"下列|正确|如图|错误", text):
        return False
    return True


def split_page(text: str, md_path: Path,
               strategy=None) -> list[RawQuestion]:
    """按题号切分试卷 MD 并对齐答案，返回 RawQuestion 列表。

    Args:
        text: 试卷 MD 全文（已 strip_chrome + normalize_fullwidth_parens）
        md_path: MD 文件路径（用于诊断日志，本函数不读）
        strategy: 学科策略；None 时用 generic（A–D / 无材料归属）。
            入口 `extract_questions_file` 一定显式传 `get_strategy(subject_code)`，
            不会落到这个默认值上。

    Returns:
        RawQuestion 列表，按题号顺序
    """
    if strategy is None:
        from subject_strategies import get_strategy
        strategy = get_strategy("generic")
    policy = strategy.material_policy()
    questions: list[RawQuestion] = []
    current: RawQuestion | None = None
    current_group_id: str | None = None
    # 当前分组的分数状态：unified（组内每题统一分）或 map（逐题给分）
    current_unified_score: int | None = None
    current_score_map: dict[int, int] | None = None
    in_answer_section = False
    current_answer_lines: list[str] = []  # 当前累积的答案文本（多行）
    current_answer_n: int | None = None  # 当前答案属于哪个题号
    last_answer_n = 0  # 答案段已见最大题号（守卫：题号必须递增，回退数字是评分细则编号）
    last_stem_no = 0   # 题干区已建的最大题号（纠正 OCR 十位错认，如 23→33）
    seen_stems: set[int] = set()  # 已建题号（防答案区/考试说明重复建题）
    warned_dup = False            # 重复题号只告警一次，避免刷屏
    # 材料分段（policy.attach）：scope = 一个大题/子小节/材料块
    scope_id = 0
    scope_pending: list[str] = []
    scope_materials: dict[int, str] = {}
    scope_has_stem = False
    # 两题之间的独立材料段（语文常见：题4选项后、题5之前的一整段文段）。
    # 旧逻辑会把它并进上一题正文，导致下一题缺材料。这里先挂起，遇到下一题再归属。
    between_material: list[str] = []
    blank_before = False

    def _start_scope() -> None:
        """进入新小节：重置待归属材料。"""
        nonlocal scope_id, scope_pending, scope_has_stem, between_material
        scope_id += 1
        scope_pending = []
        scope_has_stem = False
        between_material = []

    def _material_for_new_stem() -> str | None:
        """首题到来：把此前累积的材料锁定为该节共享材料。"""
        nonlocal scope_has_stem
        if not scope_has_stem:
            text_ = "\n".join(scope_pending).strip()
            if text_:
                scope_materials[scope_id] = text_
            scope_has_stem = True
        return scope_materials.get(scope_id)

    def _flush_answer():
        """把累积的答案塞入对应题。"""
        nonlocal current_answer_lines, current_answer_n, last_answer_n
        if current_answer_n is None or not current_answer_lines:
            current_answer_lines = []
            current_answer_n = None
            return
        answer_text = _strip_answer_prefix("\n".join(current_answer_lines))
        for q in questions:
            if q.group_order == current_answer_n:
                if q.answer:
                    q.answer += "\n" + answer_text  # 多段答案合并
                else:
                    q.answer = answer_text
                break
        last_answer_n = max(last_answer_n, current_answer_n)
        current_answer_lines = []
        current_answer_n = None

    lines = text.split('\n')
    current_part_kind: str | None = None  # 状态机：当前所在部分（'choice'/'non_choice'）
    for i, line in enumerate(lines):
        if not line.strip():
            blank_before = True
            continue
        has_blank_before = blank_before
        blank_before = False

        if is_date_trap(line):
            continue

        part_ok, part_kind = is_part_header(line)
        if part_ok:
            # 卷内部分标题（'## 第二部分 非选择题'）：关闭当前题、丢弃该行，
            # 不改 group_id/分数状态（大题分组由后续 '一、选择题' 决定）
            if in_answer_section:
                _flush_answer()
            elif current is not None:
                questions.append(current)
                current = None
            current_part_kind = part_kind
            # 不带「选择/非选择」字样的部分标题（'第一部分 北京城市发展史上的水源问题'）
            # 是材料分区，不是题型分区：标题 + 其后正文是下一题的共享材料，必须开新 scope。
            # 否则下一题仍挂着上一部分的材料 —— 东直门 2024 题3/5/6 全部拿到了「前言」，
            # 模型只能判「材料不完整」，把正常题标成待复核。
            if policy.attach and part_kind is None:
                _start_scope()
                scope_pending.append(line)
            continue

        ok, gid = is_group_header(line)

        # 题干区行内粘连（MinerU 把选项行与下一题合并成一行）：
        # '…6层以下楼房。16.根据材料三…'。不拆的话整段被吞进上一题的选项 D，
        # 题16 直接消失（大兴 2024 实测）。只在题号 == 上一题+1 时生效。
        if not ok and not in_answer_section and current is not None:
            glued = _split_glued_next_stem(line, current.group_order + 1)
            if glued is not None:
                head, tail_no, tail = glued
                body, inline_gid = split_inline_group_header(head)
                if body:
                    current.content += "\n" + body
                if inline_gid:
                    current_group_id = inline_gid
                    current_unified_score = None
                    current_score_map = None
                questions.append(current)
                if current_score_map is not None:
                    q_score = current_score_map.get(tail_no)
                elif current_unified_score is not None:
                    q_score = current_unified_score
                else:
                    q_score = None
                current = RawQuestion(
                    group_order=tail_no,
                    group_id=current_group_id,
                    content=tail,
                    score=q_score,
                    material_text=_material_for_new_stem() if policy.attach else None,
                )
                continue

        if ok:
            if in_answer_section:
                _flush_answer()
            else:
                if current is not None:
                    questions.append(current)
                    current = None
            current_group_id = gid
            if policy.attach:
                _start_scope()
            # 解析每题分数（选择/填空'每题N分'统一分，解答题'第X题N分'逐题 map）
            score_kind, score_val = parse_group_scores(line)
            if score_kind == 'unified':
                current_unified_score = score_val
                current_score_map = None
            elif score_kind == 'map':
                current_unified_score = None
                current_score_map = score_val
            else:
                current_unified_score = None
                current_score_map = None
            continue

        if not in_answer_section and is_answer_keyword(line):
            if current is not None:
                questions.append(current)
                current = None
            in_answer_section = True
            continue

        # 主题号处理（含紧凑格式一行多题号）
        inline_stems = split_inline_stems(line) if in_answer_section else []
        # 题号判定走学科策略（`is_stem`），内核不再自己判——
        # 各科的 is_stem 目前都委托 is_main_stem，行为等价。
        ok, n = strategy.is_stem(line)
        if not ok and not in_answer_section and current_part_kind == 'choice':
            # 状态机：选择题区行首 '数字.数字'（题号+年份 '6.2025年' 或疑似小数
            # '9.5'）——若后续存在更大题号（'7.'），说明当前行是题号而非小数
            amb = _AMBIGUOUS_NUM_RE.match(line)
            if amb and _has_next_stem(lines, i + 1, int(amb.group(1)),
                                      is_stem=strategy.is_stem):
                ok, n = True, int(amb.group(1))

        if in_answer_section:
            # 表格格式选择题答案（<table>...<tr><td>题号</td>...<td>答案</td>...</table>）
            if '<table>' in line or '<table ' in line:
                table_answers = parse_answer_table(line)
                if not table_answers and current_answer_n is not None:
                    # 题号/答案表解析不出（如作文评分标准表）：作为当前题答案续行
                    current_answer_lines.append(line)
                else:
                    _flush_answer()
                    for tn, tans in table_answers.items():
                        current_answer_n = tn
                        current_answer_lines = [tans]
                        _flush_answer()
                    current_answer_n = None
                continue
            if inline_stems:
                # 紧凑格式：一行多题号答案（只收递增题号；回退数字是评分细则编号）
                fresh = [(sn, st) for sn, st in inline_stems if sn > last_answer_n]
                if not fresh:
                    if current_answer_n is not None:
                        current_answer_lines.append(line)
                    continue
                _flush_answer()  # 先把上一段答案塞入
                if len(fresh) == 1:
                    current_answer_n = fresh[0][0]
                    current_answer_lines = [fresh[0][1]]
                else:
                    # 多个题号一行：每个题号独立成段，立即 flush
                    for stem_n, stem_text in fresh:
                        current_answer_n = stem_n
                        current_answer_lines = [stem_text]
                        _flush_answer()
                    current_answer_n = None
            elif ok:
                if n <= last_answer_n:
                    # 题号回退（如作文评分细则 '1．字数不足600字…'）：当作当前答案续行，
                    # 不新建答案段——否则会串到第 1 题（2025 海淀语文卷实测事故）
                    if current_answer_n is not None:
                        current_answer_lines.append(line)
                    continue
                # 展开格式：行首单题号，开始新答案段
                _flush_answer()
                rest = _strip_main_stem_prefix(line)
                current_answer_n = n
                current_answer_lines = [rest] if rest else []
            else:
                # 答案段的续行（含小问号行 (1)(2)）
                if current_answer_n is not None:
                    current_answer_lines.append(line)
            continue

        # 题干区
        if policy.attach and not in_answer_section:
            # 文段标题（「绿绸叠翠」「流光溢彩」）：下一题换材料，上一题到此结束
            if current is not None and has_blank_before and policy.is_material_title(lines, i, line):
                questions.append(current)
                current = None
                _start_scope()
                scope_pending.append(line)
                continue
            # 材料块标题（材料一/材料二…）先判：同一节内连续材料并入同批；跨节时开启新集
            if _MATERIAL_HEAD_RE.match(line):
                if scope_has_stem:
                    if current is not None:
                        questions.append(current)
                        current = None
                    _start_scope()
                scope_pending.append(line)
                continue
            # markdown 小标题（非大题/非部分/非材料标题）：新的材料块
            # （如「活动概况」「前沿科技体验」）。若本节还没出题，说明仍是同一批材料，
            # 继续累积（「## 蜘蛛的信」「## 苔藓的回信」同属 (二) 的材料）。
            # `## 2. 甲组同学推荐…` 是题号行（MinerU 把它识别成标题），交给下面的 ok 分支。
            if line.lstrip().startswith("#") and not ok:
                if scope_has_stem:
                    if current is not None:
                        questions.append(current)
                        current = None
                    _start_scope()
                scope_pending.append(line)
                continue
            # 子小节标题（（一）（二）…）：新材料集开始，关闭上一题
            if _SECTION_HEADER_RE.match(line):
                if current is not None:
                    questions.append(current)
                    current = None
                _start_scope()
                continue

        if ok:
            # 作文题后的「要求：1. 文体不限 2. 字数…」会被 is_main_stem 认成
            # 1/2/3/4，拆出来就是 4 道没有题干的空题（北京五中 2024 实测）。
            # 只在「卷末大题（≥20）之后回到个位数」时合并——MinerU 输出顺序错乱
            # 时也会有 18→14 这类回退（汇文 2024 题18 排在题14 前面），那是真题，
            # 不能并进上一题。
            if last_stem_no >= 20 and n <= 5:
                if current is not None:
                    current.content += "\n" + line
                continue
            # 卷首考试说明（题1 之前）：直接丢弃，不占题号
            if last_stem_no == 0 and _NOTICE_RE.search(line):
                continue
            # 重复题号：答案区残留或 OCR 重复（同一题号出现两次）。直接跳过，
            # 保留第一次出现的真题。**不能顺延**：OCR 把大段内容识别成重复题号时，
            # 顺延会连锁撞上后面的真实题号，题号一路膨胀（一零一 2024 从 4 溢到 29）。
            if n in seen_stems:
                if not warned_dup:
                    print(f"[WARN] 题号重复（{n} 起），重复段已跳过；缺的题请看缺号告警",
                          flush=True)
                    warned_dup = True
                continue
            seen_stems.add(n)
            # OCR 十位错认：22 之后写成 33、再往后又是 24 → 33 实际是 23
            # （清华附中 2024 题23 实测）。只在前跳一位且个位吻合时纠正，
            # 真跳号（试卷本身缺题）不动，留给缺号告警。
            if (last_stem_no and n > last_stem_no + 1
                    and n % 10 == (last_stem_no + 1) % 10):
                print(f"[WARN] 题号疑似 OCR 错认：{last_stem_no} 之后出现 {n}，"
                      f"按 {last_stem_no + 1} 处理", flush=True)
                n = last_stem_no + 1
            last_stem_no = max(last_stem_no, n)
            if current is not None:
                questions.append(current)
            # 从分组分数状态确定本题分数
            if current_score_map is not None:
                q_score = current_score_map.get(n)
            elif current_unified_score is not None:
                q_score = current_unified_score
            else:
                q_score = None
            content = _strip_main_stem_prefix(line)
            material = _material_for_new_stem() if policy.attach else None
            if policy.attach and between_material:
                extra = "\n".join(between_material).strip()
                material = (f"{material}\n\n{extra}".strip() if material else extra)
                between_material = []
            # 行尾粘连的下一节标题：题干去掉标题，后续题归新分组
            content, inline_gid = split_inline_group_header(content)
            current = RawQuestion(
                group_order=n,
                group_id=current_group_id,
                content=content,
                score=q_score,
                material_text=material,
            )
            if inline_gid:
                # 行内标题属于下一节：本题（上一节最后一题）到此结束，
                # 否则后续材料段落会被吞进本题题干
                questions.append(current)
                current = None
                current_group_id = inline_gid
                current_unified_score = None
                current_score_map = None
                if policy.attach:
                    _start_scope()
            continue

        if is_sub_stem(line):
            if current is not None:
                current.content += "\n" + line
            continue

        # 两题之间的独立文段（语文综合运用/阅读常见）：上一题选项已完整，
        # 空行后的长段落归下一题材料，不能并进上一题正文（大兴 2024 题4/题5 实测）。
        if (policy.attach and current is not None and has_blank_before
                and policy.looks_like_between_material(current.content, line)):
            between_material.append(line)
            continue

        if current is not None:
            body, inline_gid = split_inline_group_header(line)
            if body:
                current.content += "\n" + body
            if inline_gid:
                current_group_id = inline_gid
                current_unified_score = None
                current_score_map = None
                if policy.attach:
                    _start_scope()
            continue

        # 题号之前的共享材料（语文阅读：材料写在题号前面）
        if policy.attach and not scope_has_stem:
            scope_pending.append(line)

    # 末尾 flush 残留答案 + 残留题
    if in_answer_section:
        _flush_answer()
    if current is not None:
        questions.append(current)

    return questions
