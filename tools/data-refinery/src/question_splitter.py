"""试卷题切分器：按题号切分 + 答案对齐（统一扫描算法）。

与教材卡的 card_splitter（按 400 字贪心合并）不同，试卷题按题号切分，
题干原文原封不动，保留所有图片引用。详见
docs/superpowers/specs/2026-09-05-exam-question-splitter-design.md。
"""

import re
from dataclasses import dataclass
from pathlib import Path

# 主题号（行首）：1-2 位数字 + . + 非数字字符（不要求空格，兼容 9.xxx / 9. xxx / 9.$...$）
_MAIN_STEM_RE = re.compile(r'^\s*(\d{1,2})\.\D')
# 主题号前缀剥离：只消费 ^\s*\d{1,2}\.，不消费 . 后的内容字符（避免无空格格式 '9.若' 丢首字）
_STEM_PREFIX_RE = re.compile(r'^\s*\d{1,2}\.')
# 紧凑格式（行内，答案区一行多题号）：(?<!\d) 防止把 19.5 的小数点误切
_INLINE_STEM_RE = re.compile(r'(?<!\d)(\d{1,2})\.\D')
# 小问号：行首 (N) 或（N）
_SUB_STEM_RE = re.compile(r'^\s*[\(（](\d{1,2})[\)）]')
# 大题分组标题：行首可选 markdown # 前缀 + 中文序号 + 、（兼容 "## 一、选择题"）
_GROUP_HEADER_RE = re.compile(r'^#{0,6}\s*([一二三四五六七八九十]+)、')
# 日期/页码陷阱：行首 4 位数字 + . + 数字（如 2026.5）
_DATE_TRAP_RE = re.compile(r'^\s*\d{4}\.\d')
# 答案关键字（行内搜索）
# 答案关键字（行内搜索）：不匹配单独的"答案"（"试题答案"会误匹配），
# 只匹配"参考答案"/"答案及评分"/"评分参考"等标题特征
_ANSWER_KEYWORD_RE = re.compile(r'参考答案|答案及评分|评分参考')


def is_date_trap(line: str) -> bool:
    """行首是否为日期/页码格式（如 2026.5），不当题号。"""
    return bool(_DATE_TRAP_RE.match(line))


def is_group_header(line: str) -> tuple[bool, str | None]:
    """行首是否为大题分组标题（如 '三、解答题'）。返回 (是否, 组号)。"""
    m = _GROUP_HEADER_RE.match(line)
    if m:
        return True, m.group(1)
    return False, None


def is_main_stem(line: str) -> tuple[bool, int | None]:
    """行首是否为主题号（如 '9.' '9. ' '9.$...$'）。返回 (是否, 题号 N)。

    排除 4 位年份（2026.5）和小数（9.5）—— . 后必须是非数字字符。
    """
    m = _MAIN_STEM_RE.match(line)
    if m:
        return True, int(m.group(1))
    return False, None


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
# 裸字母行内标记：'A. 文本'（点后须空格+内容——防 'A、B、C、D' 枚举误切，顿号后无空格）
_BARE_INLINE_RE = re.compile(r'(?:^|(?<=\s))([A-D])[.．](?=\s*\S)')
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
    """把选择题的题干与 4 个选项拆开（Python 确定性，不丢图）。

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
      选项 = 标记间内容，D 取到 content 末尾（自配图不被截走归题干）
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
    stem = content[:a_start].strip()
    opts = []
    for j in range(4):
        if j == 3:
            text = content[d_end:]
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


def split_page(text: str, md_path: Path) -> list[RawQuestion]:
    """按题号切分试卷 MD 并对齐答案，返回 RawQuestion 列表。

    Args:
        text: 试卷 MD 全文（已 strip_chrome + normalize_fullwidth_parens）
        md_path: MD 文件路径（用于诊断日志，本函数不读）

    Returns:
        RawQuestion 列表，按题号顺序
    """
    questions: list[RawQuestion] = []
    current: RawQuestion | None = None
    current_group_id: str | None = None
    # 当前分组的分数状态：unified（组内每题统一分）或 map（逐题给分）
    current_unified_score: int | None = None
    current_score_map: dict[int, int] | None = None
    in_answer_section = False
    current_answer_lines: list[str] = []  # 当前累积的答案文本（多行）
    current_answer_n: int | None = None  # 当前答案属于哪个题号

    def _flush_answer():
        """把累积的答案塞入对应题。"""
        nonlocal current_answer_lines, current_answer_n
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
        current_answer_lines = []
        current_answer_n = None

    for line in text.split('\n'):
        if not line.strip():
            continue

        if is_date_trap(line):
            continue

        ok, gid = is_group_header(line)
        if ok:
            if in_answer_section:
                _flush_answer()
            else:
                if current is not None:
                    questions.append(current)
                    current = None
            current_group_id = gid
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
        ok, n = is_main_stem(line)

        if in_answer_section:
            # 表格格式选择题答案（<table>...<tr><td>题号</td>...<td>答案</td>...</table>）
            if '<table>' in line or '<table ' in line:
                _flush_answer()
                table_answers = parse_answer_table(line)
                for tn, tans in table_answers.items():
                    current_answer_n = tn
                    current_answer_lines = [tans]
                    _flush_answer()
                current_answer_n = None
                continue
            if inline_stems:
                # 紧凑格式：一行多题号答案
                _flush_answer()  # 先把上一段答案塞入
                if len(inline_stems) == 1:
                    current_answer_n = inline_stems[0][0]
                    current_answer_lines = [inline_stems[0][1]]
                else:
                    # 多个题号一行：每个题号独立成段，立即 flush
                    for stem_n, stem_text in inline_stems:
                        current_answer_n = stem_n
                        current_answer_lines = [stem_text]
                        _flush_answer()
                    current_answer_n = None
            elif ok:
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
        if ok:
            if current is not None:
                questions.append(current)
            # 从分组分数状态确定本题分数
            if current_score_map is not None:
                q_score = current_score_map.get(n)
            elif current_unified_score is not None:
                q_score = current_unified_score
            else:
                q_score = None
            current = RawQuestion(
                group_order=n,
                group_id=current_group_id,
                content=_strip_main_stem_prefix(line),
                score=q_score,
            )
            continue

        if is_sub_stem(line):
            if current is not None:
                current.content += "\n" + line
            continue

        if current is not None:
            current.content += "\n" + line

    # 末尾 flush 残留答案 + 残留题
    if in_answer_section:
        _flush_answer()
    if current is not None:
        questions.append(current)

    return questions
