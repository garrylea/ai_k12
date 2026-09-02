"""db_loader：把 published JSONL 加载进 MySQL，并派生教材结构（textbook_versions/semesters/units/lessons）。

本模块拆分为：
- 纯函数（subject 归一、rel_path 解析、中文数字、lesson_id 解析、sort_order 重排）：可单测。
- DbLoader 类：连库、find-or-create 结构、入库 cards/questions（集成测试覆盖）。
"""

import hashlib
import re
import unicodedata
from pathlib import Path

# ---------- subject 归一 ----------

SUBJECT_ALIASES = {
    "math": "math",
    "chem": "chemistry",
    "chemistry": "chemistry",
    "physics": "physics",
    "chinese": "chinese",
    "biology": "biology",
    "history": "history",
    "geography": "geography",
    "politics": "politics",
    "english": "english",
}


def normalize_subject(alias: str | None) -> str | None:
    """LLM 输出的 subject_id 别名（如 chem）归一到 subjects.canonical code。"""
    if not alias:
        return alias
    return SUBJECT_ALIASES.get(alias, alias)


# ---------- 题干规范化与去重哈希 ----------

def normalize_content(content: str | None) -> str:
    """题干规范化：NFKC 全半角归一 + 去所有空白 + 转小写。

    用于 content_hash 去重：同一道题不同排版/空白/全半角/大小写归一后哈希相同；
    换数换场景的变式题哈希不同（视为新题）。
    """
    if not content:
        return ""
    s = unicodedata.normalize("NFKC", content)
    s = re.sub(r"\s+", "", s)
    return s.lower()


def content_hash(content: str | None) -> str:
    """题干规范化后的 SHA-256 哈希（64 位 hex），存入 questions.content_hash 用于去重。"""
    return hashlib.sha256(normalize_content(content).encode("utf-8")).hexdigest()


# ---------- practice 题面子串校验 ----------

def _normalize_for_match(s: str) -> str:
    """与 content_hash 同口径的轻归一，用于子串校验（NFKC + 去空白 + lower）。"""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"\s+", "", s)
    return s.lower()


def question_text_valid(text: str | None, card_content: str) -> bool:
    """检查 question.text 是否是 card_content 的子串（NFKC 归一后）。

    LLM 摘录的题面应逐字来自卡片正文；若 LLM 改写/幻觉则校验失败。
    容全半角/空白差异（NFKC + 去空白 + lower 后做子串匹配）。
    """
    if not text:
        return False
    return _normalize_for_match(text) in _normalize_for_match(card_content)


def build_content_metadata(groups: list[dict] | None, card_content: str,
                           existing: dict | None) -> dict:
    """构建 content_metadata，合并 existing（如 images/override_scroll），
    对每个 group 的 questions 逐条做子串校验，无效则丢弃；
    若某 group 无有效题则丢弃整个 group；全部 group 无效则置 needs_fallback=True。

    Args:
        groups: [{"intro": str|None, "questions": [{"n":int,"text":str}]}] 或 None
        card_content: 卡片正文（用于子串校验）
        existing: 既有 content_metadata（如 publish 阶段写入的 images）

    Returns:
        合并后的 content_metadata dict
    """
    md = dict(existing or {})
    if groups is not None:
        valid_groups = []
        for g in groups:
            valid_qs = [q for q in g.get("questions", [])
                        if question_text_valid(q.get("text", ""), card_content)]
            if valid_qs:
                g2: dict = {"questions": valid_qs}
                if g.get("intro"):
                    g2["intro"] = g["intro"]
                valid_groups.append(g2)
        if valid_groups:
            md["groups"] = valid_groups
            md["needs_fallback"] = False
        else:
            md.pop("groups", None)
            md["needs_fallback"] = True
    return md


def rebuild_practice_content(groups: list[dict]) -> str:
    """用 labeler 输出的 groups 重组 practice 卡的 content。

    每个 group 的 intro 在前（若有），每题 text 用 \\n\\n 分隔；
    group 之间也用 \\n\\n 分隔。重组后每题独立成段。
    """
    parts: list[str] = []
    for g in groups:
        if g.get("intro") and g["intro"].strip():
            parts.append(g["intro"].strip())
        for q in g.get("questions", []):
            text = q.get("text", "")
            if text.strip():
                parts.append(text.strip())
    return "\n\n".join(parts)


# ---------- rel_path 解析（教材 card） ----------

def parse_book_rel_path(rel: str) -> dict | None:
    """解析教材 card 的 rel_path：subject/grade_band/publisher/grade/term/book/page.jsonl。

    返回 {subject, grade_band, publisher, grade, term, book}；非 6 段结构返回 None。
    """
    parts = Path(rel).parts
    if len(parts) < 7:
        return None
    subject, grade_band, publisher, grade, term, book = parts[:6]
    return {
        "subject": subject,
        "grade_band": grade_band,
        "publisher": publisher,
        "grade": grade,
        "term": term,
        "book": book,
    }


# ---------- 书名版次标记 ----------

_EDITION_RE = re.compile(r"^[（(]([^）)]+)[）)]")


def edition_from_book_name(book: str | None) -> str:
    """从书名提取版次标记：前导括号内容。

    如「（根据2022年版课程标准修订）义务教育教科书·数学九年级上册」
    ->「根据2022年版课程标准修订」；无前导括号返回 ''（旧版，2012 课标）。

    同一版次的九上/九下书名不同但前导括号相同 -> 归同一 textbook_version，
    故只用括号内容、不能用完整书名做版次标识。
    """
    if not book:
        return ""
    m = _EDITION_RE.match(book.strip())
    return m.group(1) if m else ""


# ---------- 中文数字 ----------

_CN_DIGITS = {"零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
              "六": 6, "七": 7, "八": 8, "九": 9}
_CN_UNITS = {"十": 10, "百": 100, "千": 1000}


def chinese_to_int(s: str) -> int:
    """中文数字转 int，如 二十六->26、一百零一->101。支持到千位。"""
    total = 0
    cur = 0
    for ch in s:
        if ch in _CN_DIGITS:
            cur = _CN_DIGITS[ch]
        elif ch in _CN_UNITS:
            u = _CN_UNITS[ch]
            if cur == 0:
                cur = 1  # 「十」单独出现视作一十
            total += cur * u
            cur = 0
    total += cur  # 末位数字（如 二十六 的「六」）
    return total


# ---------- lesson_id 解析 ----------

_CHAPTER_RE = re.compile(r"^第([一二三四五六七八九十百零]+)章\s+(.+)$")
_SECTION_RE = re.compile(r"^(\d+)\.(\d+)(?:\.(\d+))?\s+(.+)$")


def parse_lesson_id(label: str | None) -> dict | None:
    """解析 lesson_id 标签 -> {chapter, title, is_overview, section, label}。

    - 章综述「第N章 标题」-> is_overview=True, section=None
    - 节「N.M[.K] 标题」-> is_overview=False, section=(M[,K])
    - 非编号标题（练习等）或 None -> None（调用方应已继承，不应出现）
    """
    if not label:
        return None
    m = _CHAPTER_RE.match(label)
    if m:
        return {"chapter": chinese_to_int(m.group(1)), "title": m.group(2),
                "is_overview": True, "section": None, "label": label}
    m = _SECTION_RE.match(label)
    if m:
        chapter = int(m.group(1))
        sec = [int(m.group(2))]
        if m.group(3):
            sec.append(int(m.group(3)))
        return {"chapter": chapter, "title": m.group(4),
                "is_overview": False, "section": tuple(sec), "label": label}
    return None


# ---------- sort_order 全局重排 ----------

def renumber_sort_order(cards: list[dict]) -> list[dict]:
    """每个 lesson 内跨页把 sort_order 重排为 1..N（输入按页顺序）。

    抽取的 sort_order 是页内序（每页从 1 起），跨页会碰撞 uniq_cards_lesson_sort；
    入库前按 lesson 分组、按出现序全局重排。
    """
    out = []
    per_lesson: dict[str | None, int] = {}
    for c in cards:
        c2 = dict(c)
        lid = c2.get("lesson_id")
        per_lesson[lid] = per_lesson.get(lid, 0) + 1
        c2["sort_order"] = per_lesson[lid]
        out.append(c2)
    return out


# ---------- rel_path 段 -> code 映射 ----------

GRADE_BAND_MAP = {"小学": "primary", "初中": "junior", "高中": "senior"}
TERM_MAP = {"上册": "first", "下册": "second"}
_GRADE_RE = re.compile(r"^(.+)年级$")


def grade_to_code(grade: str) -> str:
    """九年级 -> grade_9（支持中文数字年级）。"""
    m = _GRADE_RE.match(grade)
    if not m:
        return grade
    return f"grade_{chinese_to_int(m.group(1))}"


def _subject_code_by_name_fallback(name: str) -> str:
    """根据 subject 中文名找 code，找不到返回原名。"""
    name_map = {"数学": "math", "语文": "chinese", "英语": "english",
                "物理": "physics", "化学": "chemistry", "生物": "biology",
                "历史": "history", "地理": "geography", "道德与法治": "politics"}
    return name_map.get(name, name)


def _grade_band_from_path(toc_path: str) -> str:
    """从 TOC 路径推断 grade_band。"""
    if "小学" in toc_path:
        return "primary"
    elif "高中" in toc_path:
        return "senior"
    return "junior"


# ---------- DbLoader ----------

import json  # noqa: E402

import pymysql  # noqa: E402

from lesson_anchor import (  # noqa: E402
    LessonAnchor,
    is_review_label,
    md_page_of,
    parse_chapter_from_content,
    parse_chapter_from_label,
)


class DbLoader:
    """连 MySQL，find-or-create 教材结构，入库 cards/questions。

    幂等：textbook_versions/semesters/units/lessons 用 find-or-create（按唯一键查再插）；
    cards/questions 用 full-reload（reset_* 先 DELETE 再重插）。
    full-reload 的 DELETE 会被业务表 FK（answers/错题本/variation_questions 等 ON DELETE
    RESTRICT）挡住：business_data_summary() 预检、purge_business_data() 显式清空
    （CLI 需传 --purge-business-data，否则遇业务数据直接报错退出）。
    """

    def __init__(self, host: str, port: int, user: str, password: str, db: str):
        self._conn = pymysql.connect(host=host, port=port, user=user,
                                     password=password, database=db, charset="utf8mb4")
        self._subj_name: dict[str, tuple] = {}   # name -> (id, code)
        self._subj_code: dict[str, int] = {}     # code -> id
        self._tv: dict[tuple, int] = {}          # (subject_code, publisher, gb, edition) -> id
        self._sem: dict[tuple, int] = {}         # (tv, grade, term) -> id
        self._unit: dict[tuple, int] = {}        # (sem, chapter) -> id
        self._lesson: dict[tuple, int] = {}      # (unit, name) -> id

    def close(self):
        self._conn.close()

    # --- 底层 ---
    def _exec(self, sql, args=None):
        with self._conn.cursor() as cur:
            cur.execute(sql, args)

    def _query(self, sql, args=None):
        with self._conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()

    def _count(self, table: str) -> int:
        return self._query(f"SELECT COUNT(*) FROM {table}")[0][0]

    def _table_exists(self, table: str) -> bool:
        """information_schema 查表是否存在（schema.sql 与线上库可能不同步，如 aux_error_books）。"""
        return bool(self._query(
            "SELECT 1 FROM information_schema.tables"
            " WHERE table_schema=DATABASE() AND table_name=%s", (table,)))

    def _delete(self, sql, args=None) -> int:
        """执行 DELETE 并返回影响行数。"""
        with self._conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.rowcount

    # --- full-reload 业务数据守卫 ---
    # 会挡住 full-reload DELETE 的业务表（FK ON DELETE RESTRICT，或经 CASCADE 链传导）：
    # - questions 的 RESTRICT 引用：answers / aux_error_books / main_error_books / variation_questions / exam_answers
    #   （practice_questions 的 question_id 是 SET NULL、question_knowledge_points 是 CASCADE，不挡）
    # - textbook_versions 级联链（semesters->units->lessons->cards）的阻挡：
    #   progress.textbook_version_id RESTRICT；homeworks.lesson_id CASCADE 会连带删 homeworks，
    #   再被 homework_submissions.homework_id RESTRICT 挡住。
    QUESTIONS_BLOCKERS = ["answers", "aux_error_books", "main_error_books", "variation_questions", "exam_answers"]
    # practice_results.card_id 是 ON DELETE CASCADE——不挡 DELETE 但会**静默连带删除**
    # 学生练习记录，必须进守卫名单（与 homework_submissions 同理）
    CARDS_BLOCKERS = ["homework_submissions", "practice_results"]  # progress 单独处理（只清 textbook_version_id 非空行）

    def business_data_summary(self, reset_cards: bool, reset_questions: bool) -> dict[str, int]:
        """统计会挡住本次 full-reload 的业务数据行数（>0 的表会让 DELETE 报 FK 1451）。"""
        counts: dict[str, int] = {}
        if reset_questions:
            for t in self.QUESTIONS_BLOCKERS:
                if self._table_exists(t):
                    counts[t] = self._count(t)
            # error_redo_logs 多态挂在错题本上，错题本清空时一并清
            if self._table_exists("error_redo_logs"):
                counts["error_redo_logs"] = self._count("error_redo_logs")
        if reset_cards:
            for t in self.CARDS_BLOCKERS:
                if self._table_exists(t):
                    counts[t] = self._count(t)
            if self._table_exists("progress"):
                counts["progress"] = self._query(
                    "SELECT COUNT(*) FROM progress WHERE textbook_version_id IS NOT NULL")[0][0]
        return counts

    def purge_business_data(self, reset_cards: bool, reset_questions: bool) -> dict[str, int]:
        """按 FK 安全顺序清空挡住 full-reload 的业务表（先子表后父表）。

        显式破坏性操作：仅当 CLI 传了 --purge-business-data 才应调用。
        """
        deleted: dict[str, int] = {}
        if reset_questions:
            # exam_sessions 先清：exam_answers.session_id 是 ON DELETE CASCADE 会连带清答案
            # （后续 blockers 里 DELETE FROM exam_answers 为幂等空操作）；
            # exam_sessions 本身不挡 questions DELETE，但答案清空后会话成孤儿，一并清
            for t in ["exam_sessions", "error_redo_logs"] + self.QUESTIONS_BLOCKERS:
                if self._table_exists(t):
                    deleted[t] = self._delete(f"DELETE FROM {t}")
        if reset_cards:
            if self._table_exists("homework_submissions"):
                deleted["homework_submissions"] = self._delete("DELETE FROM homework_submissions")
            # homeworks 经 lessons CASCADE 自动清；只删绑定了旧教材结构的 progress 行
            if self._table_exists("progress"):
                deleted["progress"] = self._delete(
                    "DELETE FROM progress WHERE textbook_version_id IS NOT NULL")
        self._conn.commit()
        return deleted

    # --- subject 查 ---
    def _subject_by_name(self, name: str):
        if name not in self._subj_name:
            row = self._query("SELECT id, code FROM subjects WHERE name=%s", (name,))
            if not row:
                raise ValueError(f"subjects 未 seed name={name!r}")
            self._subj_name[name] = row[0]
        return self._subj_name[name]

    def _subject_id_by_name(self, name: str) -> int:
        return self._subject_by_name(name)[0]

    def _subject_code_by_name(self, name: str) -> str:
        return self._subject_by_name(name)[1]

    def _subject_id_by_code(self, code: str) -> int:
        if code not in self._subj_code:
            row = self._query("SELECT id FROM subjects WHERE code=%s", (code,))
            if not row:
                raise ValueError(f"subjects 未 seed code={code!r}")
            self._subj_code[code] = row[0][0]
        return self._subj_code[code]

    # --- find-or-create 结构 ---
    def _find_or_create_textbook_version(self, subject_code: str, publisher: str,
                                          grade_band: str, edition: str = "") -> int:
        """按 (subject_id, publisher, grade_band, edition) 4 元组 find-or-create。

        edition 为书名前导括号提取的版次标记（edition_from_book_name）：
        ''=旧版（2012 课标），非空如「根据2022年版课程标准修订」。同一出版社
        不同课标版次 -> 各自独立的 textbook_version/semesters/units/lessons/cards。
        code 仅作展示/兜底唯一键（edition 非空时拼进 code 保证不撞 uniq_code）。
        """
        key = (subject_code, publisher, grade_band, edition)
        if key in self._tv:
            return self._tv[key]
        row = self._query(
            "SELECT id FROM textbook_versions WHERE subject_id=%s AND publisher=%s "
            "AND grade_band=%s AND edition=%s",
            (self._subject_id_by_code(subject_code), publisher, grade_band, edition))
        if row:
            self._tv[key] = row[0][0]
            return row[0][0]
        if edition:
            code = f"{subject_code}_{publisher}_{edition}_{grade_band}"
            name = f"{publisher}（{edition}）"
        else:
            code = f"{subject_code}_{publisher}_{grade_band}"
            name = publisher
        self._exec(
            "INSERT INTO textbook_versions (subject_id, name, code, grade_band, publisher, edition, is_active) "
            "VALUES (%s,%s,%s,%s,%s,%s,1)",
            (self._subject_id_by_code(subject_code), name, code, grade_band, publisher, edition),
        )
        tid = self._query(
            "SELECT id FROM textbook_versions WHERE subject_id=%s AND publisher=%s "
            "AND grade_band=%s AND edition=%s",
            (self._subject_id_by_code(subject_code), publisher, grade_band, edition))[0][0]
        self._tv[key] = tid
        return tid

    def _find_or_create_semester(self, tv_id: int, grade_code: str, term_code: str, name: str) -> int:
        key = (tv_id, grade_code, term_code)
        if key in self._sem:
            return self._sem[key]
        row = self._query(
            "SELECT id FROM semesters WHERE textbook_version_id=%s AND grade=%s AND term=%s",
            key,
        )
        if row:
            self._sem[key] = row[0][0]
            return row[0][0]
        grade_num = int(grade_code.replace("grade_", "")) if grade_code.startswith("grade_") else 0
        sort_order = grade_num * 2 + (1 if term_code == "second" else 0)
        self._exec(
            "INSERT INTO semesters (textbook_version_id, name, grade, term, sort_order) "
            "VALUES (%s,%s,%s,%s,%s)",
            (tv_id, name, grade_code, term_code, sort_order),
        )
        sid = self._query(
            "SELECT id FROM semesters WHERE textbook_version_id=%s AND grade=%s AND term=%s", key
        )[0][0]
        self._sem[key] = sid
        return sid

    def _find_or_create_unit(self, sem_id: int, chapter: int, name: str) -> int:
        key = (sem_id, chapter)
        if key in self._unit:
            return self._unit[key]
        row = self._query("SELECT id FROM units WHERE semester_id=%s AND sort_order=%s", key)
        if row:
            self._unit[key] = row[0][0]
            return row[0][0]
        self._exec(
            "INSERT INTO units (semester_id, name, sort_order, is_midterm_boundary) VALUES (%s,%s,%s,0)",
            (sem_id, name, chapter),
        )
        uid = self._query("SELECT id FROM units WHERE semester_id=%s AND sort_order=%s", key)[0][0]
        self._unit[key] = uid
        return uid

    def _find_or_create_lesson(self, unit_id: int, name: str, sort_order: int) -> int:
        key = (unit_id, name)
        if key in self._lesson:
            return self._lesson[key]
        row = self._query("SELECT id FROM lessons WHERE unit_id=%s AND name=%s", key)
        if row:
            self._lesson[key] = row[0][0]
            return row[0][0]
        self._exec(
            "INSERT INTO lessons (unit_id, name, sort_order, is_unit_last) VALUES (%s,%s,%s,0)",
            (unit_id, name, sort_order),
        )
        lid = self._query("SELECT id FROM lessons WHERE unit_id=%s AND name=%s", key)[0][0]
        self._lesson[key] = lid
        return lid

    def _match_lesson_by_name(self, name: str) -> int | None:
        """按 lesson name 查已有 lesson 的 DB id（全局按名查，向后兼容旧调用）。"""
        row = self._query("SELECT id FROM lessons WHERE name=%s", (name,))
        if row:
            return row[0][0]
        return None

    def _lookup_semester(self, info: dict) -> int | None:
        """find-only：按 rel_path 信息（含书名版次标记）查 semester id（不创建；查不到返回 None）。"""
        subject_code = _subject_code_by_name_fallback(info["subject"])
        gb = GRADE_BAND_MAP.get(info["grade_band"], "junior")
        grade_code = grade_to_code(info["grade"])
        term_code = TERM_MAP.get(info["term"], "first")
        edition = edition_from_book_name(info.get("book"))
        row = self._query(
            "SELECT s.id FROM semesters s JOIN textbook_versions tv ON s.textbook_version_id=tv.id "
            "WHERE tv.subject_id=%s AND tv.publisher=%s AND tv.grade_band=%s AND tv.edition=%s "
            "AND s.grade=%s AND s.term=%s",
            (self._subject_id_by_code(subject_code), info["publisher"], gb, edition,
             grade_code, term_code),
        )
        return row[0][0] if row else None

    def _lookup_unit(self, sem_id: int, chapter: int) -> int | None:
        """find-only：按 (semester_id, sort_order=chapter) 查 unit id（不创建）。"""
        row = self._query(
            "SELECT id FROM units WHERE semester_id=%s AND sort_order=%s", (sem_id, chapter))
        return row[0][0] if row else None

    def _semester_card_stats(self, sem_id: int) -> tuple[int, int]:
        """(该书已入库卡数, 其中被学生练习记录引用的卡数)。

        practice_results.card_id ON DELETE CASCADE（删卡会连带删学生练习记录），
        是按书替换前必须检查的业务数据；ai_dialogues.card_id 是 SET NULL 无损。
        """
        cards_n = self._query(
            "SELECT COUNT(*) FROM cards c JOIN lessons l ON c.lesson_id=l.id "
            "JOIN units u ON l.unit_id=u.id WHERE u.semester_id=%s", (sem_id,))[0][0]
        practice_n = 0
        if self._table_exists("practice_results"):
            practice_n = self._query(
                "SELECT COUNT(*) FROM practice_results pr JOIN cards c ON pr.card_id=c.id "
                "JOIN lessons l ON c.lesson_id=l.id JOIN units u ON l.unit_id=u.id "
                "WHERE u.semester_id=%s", (sem_id,))[0][0]
        return cards_n, practice_n

    def _replace_semester_cards(self, sem_id: int) -> int:
        """删除该书已入库的卡（重插前调用，保证增量入库幂等）。

        FK 语义：ai_dialogues.card_id ON DELETE SET NULL（无损）；
        practice_results.card_id ON DELETE CASCADE —— 调用方必须先用
        _semester_card_stats 确认练习记录为 0。
        """
        return self._delete(
            "DELETE c FROM cards c JOIN lessons l ON c.lesson_id=l.id "
            "JOIN units u ON l.unit_id=u.id WHERE u.semester_id=%s", (sem_id,))

    def _match_lesson_scoped(self, name: str, semester_id: int | None) -> int | None:
        """在书的 semester 作用域内按名匹配 lesson（修复跨书同名误匹配）。

        优先 unit 精确匹配（label 可解析出章号时按 (semester, chapter) 定位 unit），
        miss 再退到 semester 范围；semester_id 为 None 时退化为全局按名查（旧行为）。
        """
        if semester_id is None:
            return self._match_lesson_by_name(name)
        parsed = parse_lesson_id(name)
        if parsed:
            unit_id = self._lookup_unit(semester_id, parsed["chapter"])
            if unit_id is not None:
                row = self._query(
                    "SELECT id FROM lessons WHERE unit_id=%s AND name=%s", (unit_id, name))
                if row:
                    return row[0][0]
        row = self._query(
            "SELECT l.id FROM lessons l JOIN units u ON l.unit_id=u.id "
            "WHERE u.semester_id=%s AND l.name=%s", (semester_id, name))
        return row[0][0] if row else None

    def _match_parent_lesson(self, name: str, semester_id: int | None = None) -> int | None:
        """子节归并：'21.2.2 公式法' → 找父节 '21.2 解一元二次方程' 的 lesson id。

        仅当 name 形如 N.M.K 且有标题（节标题）时，逐级向上找 N.M 父节。
        semester_id 给定时在作用域内匹配（前缀 LIKE 也限定作用域）。
        """
        m = re.match(r"^(\d+\.\d+)\.\d+\s+(.+)$", name.strip())
        if not m:
            return None
        parent_prefix, parent_title = m.group(1), m.group(2)
        # 1) 精确父节：21.2 + 标题 的后缀 2) 仅前缀匹配已存在的 lesson（如 '21.2 解一元二次方程'）
        parent_label = f"{parent_prefix} {parent_title}"
        lid = self._match_lesson_scoped(parent_label, semester_id)
        if lid is not None:
            return lid
        # 前缀匹配：作用域内任何 name 以 '21.2 ' 开头的 lesson
        if semester_id is not None:
            row = self._query(
                "SELECT l.id FROM lessons l JOIN units u ON l.unit_id=u.id "
                "WHERE u.semester_id=%s AND l.name LIKE %s ORDER BY l.sort_order LIMIT 1",
                (semester_id, f"{parent_prefix} %"))
        else:
            row = self._query(
                "SELECT id FROM lessons WHERE name LIKE %s ORDER BY sort_order LIMIT 1",
                (f"{parent_prefix} %",))
        return row[0][0] if row else None

    # ---------- sort_order 防重复/重排 ----------

    _CHAPTER_OVERVIEW_RE = re.compile(r"^第[一二三四五六七八九十百零]+章\s+")
    _LESSON_NUM_RE = re.compile(r"^(\d+)\.(\d+)(?:\.(\d+))?\b")
    _PAGE_NUM_RE = re.compile(r"(\d+)")

    def _parse_sort_key(self, name: str) -> tuple:
        """用于 lessons 重排的排序键。数值越小越靠前。"""
        if not name:
            return (2, 0, 0, 0)
        if self._CHAPTER_OVERVIEW_RE.match(name):
            return (0, 0, 0, 0)
        m = self._LESSON_NUM_RE.match(name)
        if m:
            chap = int(m.group(1))
            main = int(m.group(2))
            sub = int(m.group(3)) if m.group(3) else 0
            return (0, chap, main, sub)
        # 无编号：靠页码兜底（在 _renumber_lessons 中填充第5个元素）
        return (1, 0, 0, 0)

    def _extract_page_num(self, textbook_page: str | None) -> int:
        """从 textbook_page（如 'P8'、'12'、'P12-13'）提取首个数字，失败返回 999999。"""
        if not textbook_page:
            return 999999
        m = self._PAGE_NUM_RE.search(textbook_page)
        return int(m.group(1)) if m else 999999

    def _renumber_lessons(self, unit_id: int):
        """按 lesson name 语义重新分配 sort_order（0 起，连续无重复）。

        策略：
        1. 有明确章节编号的（如 21.2 / 21.2.1）按编号排序
        2. 章综述（第N章）排最前
        3. 无编号的按内容首次出现的页码排序（页码也缺失的保持原相对顺序）
        """
        rows = self._query("SELECT id, name, sort_order FROM lessons WHERE unit_id=%s", (unit_id,))
        if len(rows) <= 1:
            return

        lesson_ids = [r[0] for r in rows]
        # 查询每个 lesson 关联 cards 的最小页码
        page_map: dict[int, int] = {}
        if lesson_ids:
            placeholders = ",".join(["%s"] * len(lesson_ids))
            page_rows = self._query(
                f"SELECT lesson_id, MIN(textbook_page) FROM cards WHERE lesson_id IN ({placeholders}) GROUP BY lesson_id",
                tuple(lesson_ids),
            )
            for lid, tp in page_rows:
                page_map[lid] = self._extract_page_num(tp)

        rows_with_key = []
        for rid, name, old_so in rows:
            base_key = self._parse_sort_key(name)
            # 排序键：(类别标识, chapter, main, sub, 页码)
            # 有编号：base_key[0]==0，页码=0（编号已足够）
            # 无编号：base_key[0]==1，页码兜底
            # 综述：base_key[0]==0 且全0
            page = page_map.get(rid, 999999)
            if base_key[0] == 0:
                sort_key = (0, base_key[1], base_key[2], base_key[3], 0)
            else:
                sort_key = (1, 0, 0, 0, page)
            rows_with_key.append((rid, name, old_so, sort_key))

        rows_with_key.sort(key=lambda x: (x[3], x[2]))  # 键相同则保持原顺序
        for new_order, (rid, name, old_so, key) in enumerate(rows_with_key):
            self._exec("UPDATE lessons SET sort_order=%s WHERE id=%s", (new_order, rid))

    def load_toc_structure(self, toc_path: str) -> dict:
        """用 TOC JSON 全量建教材骨架。

        从 TOC JSON 文件路径推导 rel_path 结构，逐条 find-or-create：
        textbook_version → semester → units → lessons。
        幂等：已存在的 unit/lesson 不重复创建。

        路径格式：output/toc/{subject}/{grade_band}/{publisher}/{grade}/{term}/{book}.json

        Returns:
            dict: {toc_path: str, chapters: int, lessons: int}
        """
        with open(toc_path, encoding="utf-8") as f:
            toc = json.load(f)

        toc_file = Path(toc_path)
        parent_parts = toc_file.parent.parts
        # Path: .../toc/{subject}/{grade_band}/{publisher}/{grade}/{term}/
        # Take the last 5 segments (matches book_dir structure from toc_parse_cli)
        if len(parent_parts) >= 5:
            subject_name = parent_parts[-5]
            grade_band_raw = parent_parts[-4]   # "初中"
            publisher = parent_parts[-3]         # "人教版"
            grade = parent_parts[-2]             # "九年级"
            term = parent_parts[-1]              # "上册"
        else:
            raise ValueError(
                f"无法从 TOC 路径解析教材结构，期望 5 级父目录 "
                f"{{subject}}/{{grade_band}}/{{publisher}}/{{grade}}/{{term}}/，"
                f"实际: {toc_file.parent}"
            )

        subject_code = _subject_code_by_name_fallback(subject_name)
        gb = GRADE_BAND_MAP.get(grade_band_raw, "junior")
        grade_code = grade_to_code(grade)
        term_code = TERM_MAP.get(term, "first")

        # 书名 = TOC 文件名（剥 .merged.json 后缀），用于提取版次标记
        book = toc_file.stem
        if book.endswith(".merged"):
            book = book[: -len(".merged")]
        edition = edition_from_book_name(book)

        tv_id = self._find_or_create_textbook_version(subject_code, publisher, gb, edition)
        sem_name = f"{grade}{term}"
        sem_id = self._find_or_create_semester(tv_id, grade_code, term_code, sem_name)

        chapters_count = 0
        lessons_count = 0

        for ch in toc.get("chapters", []):
            chapter_num = ch.get("number", 0)
            chapter_label = ch.get("label", f"第{chapter_num}章")

            # 建 unit（章）
            unit_id = self._find_or_create_unit(sem_id, chapter_num, chapter_label)
            chapters_count += 1

            # 建 章综述 lesson (sort_order=0)
            self._find_or_create_lesson(unit_id, chapter_label, 0)
            lessons_count += 1
            last_lesson_name = chapter_label

            # 建 节 lessons
            lesson_sort = 0
            for sec in ch.get("sections", []):
                lesson_sort += 1
                sec_label = sec.get("label", "")
                if sec_label:
                    self._find_or_create_lesson(unit_id, sec_label, lesson_sort)
                    lessons_count += 1
                    last_lesson_name = sec_label

                for sub in sec.get("subsections", []):
                    lesson_sort += 1
                    sub_label = sub.get("label", "")
                    if sub_label:
                        self._find_or_create_lesson(unit_id, sub_label, lesson_sort)
                        lessons_count += 1
                        last_lesson_name = sub_label

            # 建 supplement lessons (排在所有节之后)
            for supp in ch.get("supplements", []):
                lesson_sort += 1
                supp_label = supp.get("label", "")
                if supp_label:
                    self._find_or_create_lesson(unit_id, supp_label, lesson_sort)
                    lessons_count += 1
                    last_lesson_name = supp_label

            # 标记单元最后一课：先清再设，保证重跑幂等
            self._exec("UPDATE lessons SET is_unit_last=0 WHERE unit_id=%s", (unit_id,))
            self._exec(
                "UPDATE lessons SET is_unit_last=1 WHERE unit_id=%s AND name=%s",
                (unit_id, last_lesson_name),
            )

            # 重排 sort_order：防止新增/已有 lesson 的 sort_order 重复或错乱
            self._renumber_lessons(unit_id)

        self._conn.commit()
        return {"toc_path": toc_path, "chapters": chapters_count, "lessons": lessons_count}

    # --- reset（full-reload） ---
    def reset_cards(self):
        # DELETE textbook_versions 级联清空 semesters/units/lessons/cards，保证结构重建（名称等不残留）
        self._exec("DELETE FROM textbook_versions")
        self._tv.clear()
        self._sem.clear()
        self._unit.clear()
        self._lesson.clear()
        self._conn.commit()

    def reset_questions(self):
        self._exec("DELETE FROM questions")
        self._conn.commit()

    # --- 页码锚定（2026-09-02）---

    def _build_anchor_ctx(self, toc_path, cards: list[dict], sem_id: int | None):
        """构建锚定上下文：TOC 章区间 + 该书 skeleton 的 unit/lesson 视图。

        返回 (anchor, unit_by_chapter, lessons_by_unit, overview_by_unit,
        ambiguous_names)；不可用（无 TOC/偏移推不出/查不到骨架）返回 None，
        调用方退化为既有匹配行为。
        """
        if not toc_path or sem_id is None:
            return None
        try:
            toc = json.loads(Path(toc_path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        anchor = LessonAnchor.build(toc, cards)
        if anchor is None:
            return None
        unit_rows = self._query(
            "SELECT id, sort_order FROM units WHERE semester_id=%s", (sem_id,))
        if not unit_rows:
            return None
        unit_by_chapter = {row[1]: row[0] for row in unit_rows}
        lesson_rows = self._query(
            "SELECT l.id, l.name, l.unit_id, l.sort_order FROM lessons l "
            "JOIN units u ON l.unit_id=u.id WHERE u.semester_id=%s", (sem_id,))
        if not lesson_rows:
            return None
        lessons_by_unit: dict[int, list[tuple[int, str, int]]] = {}
        name_units: dict[str, set[int]] = {}
        for lid_db, name, uid, sort_order in lesson_rows:
            lessons_by_unit.setdefault(uid, []).append((lid_db, name, sort_order))
            name_units.setdefault(name, set()).add(uid)
        # 每章章综述 lesson（sort_order 最小者）作错章兜底
        overview_by_unit = {uid: min(ls, key=lambda t: t[2])[0]
                            for uid, ls in lessons_by_unit.items()}
        # 同名歧义（小结/数学活动等在 >=2 个 unit 出现的名字）
        ambiguous_names = {n for n, uids in name_units.items() if len(uids) >= 2}
        return (anchor, unit_by_chapter, lessons_by_unit,
                overview_by_unit, ambiguous_names)

    def _anchor_lesson_id(self, c: dict, anchor_ctx) -> tuple[int | None, str | None]:
        """页码锚定修正单卡：返回 (lesson_db_id, action)。

        action: corrected（错章重写）/ disambiguated（同名消歧）/
        normalized（复习题归一）；(None, None) 表示锚定无意见，走既有匹配。
        """
        (anchor, unit_by_chapter, lessons_by_unit,
         overview_by_unit, ambiguous_names) = anchor_ctx
        page = md_page_of(c.get("textbook_page"))
        if page is None:
            return None, None
        page_ch = anchor.chapter_of(page)
        if page_ch is None:
            return None, None
        lid = c.get("lesson_id")
        content_ch = parse_chapter_from_content(c.get("content"))
        label_ch = parse_chapter_from_label(lid) if lid else None
        target_ch = content_ch or page_ch

        def lesson_in(ch, name):
            uid = unit_by_chapter.get(ch)
            if uid is None:
                return None
            for lid_db, lname, _ in lessons_by_unit.get(uid, []):
                if lname == name:
                    return lid_db
            return None

        # 规则 A：标签章号与锚定章不符（LLM 错章）
        if label_ch is not None and label_ch != target_ch:
            if content_ch is not None:
                ldb = lesson_in(content_ch, "小结")
                if ldb:
                    return ldb, "corrected"
            else:
                # 时间线活跃节优先（如错章卡落在小结/复习题区段 -> 该章小结）
                label_t = anchor.active_label_at(page)
                if label_t:
                    ldb = lesson_in(target_ch, label_t)
                    if ldb:
                        return ldb, "corrected"
                uid = unit_by_chapter.get(target_ch)
                if uid is not None:
                    # 标签标题部分在目标章内找（如错章节号同题），miss 落章综述
                    p = parse_lesson_id(lid) if lid else None
                    title = p["title"] if p else None
                    if title:
                        for lid_db, lname, _ in lessons_by_unit.get(uid, []):
                            if lname == title or lname.endswith(f" {title}"):
                                return lid_db, "corrected"
                    ldb = overview_by_unit.get(uid)
                    if ldb:
                        return ldb, "corrected"
            return None, None

        # 规则 B：同名歧义标签（每章同名的小结/数学活动等）按页所在章消歧
        if lid and label_ch is None and lid.strip() in ambiguous_names:
            ldb = lesson_in(page_ch, lid.strip())
            if ldb:
                return ldb, "disambiguated"

        # 规则 C：复习题标签归一到该章「小结」（不建「复习题 N」lesson）
        if lid and is_review_label(lid):
            ldb = lesson_in(target_ch, "小结")
            if ldb:
                return ldb, "normalized"

        return None, None

    # --- 入库 ---
    def load_book_cards(self, book_rel: str, cards: list[dict], toc_path: str | None = None) -> int:
        info = parse_book_rel_path(book_rel)
        if not info:
            raise ValueError(f"无法解析教材 rel_path: {book_rel!r}")

        if toc_path:
            # TOC 模式：不动态建结构，card 直接匹配已有 lesson
            # sort_order 按 DB lesson 内从 1 开始（与 full-reload 一致）；
            # 子节（如 21.2.2）归并到父节（21.2）后，同一 DB lesson 下连续编号。
            # 注意：pipeline 应传 toc_merge 的 merged TOC（骨架已含补充小节，
            # exact 匹配几乎全命中，坍缩只兜底漏网标签）。
            # 作用域：按书的 rel_path 定位 semester，避免跨书同名 lesson 误匹配。
            sem_id = self._lookup_semester(info)
            if sem_id is None:
                print(f"[WARN] {book_rel}: 未找到对应 semester（骨架未建？），"
                      f"lesson 匹配退化为全局按名查", flush=True)
            else:
                # 按书替换：先删该书已入库的卡再重插，保证重复运行幂等
                # （否则撞 uniq_cards_lesson_sort 唯一键）。
                cards_n, practice_n = self._semester_card_stats(sem_id)
                if practice_n > 0:
                    raise RuntimeError(
                        f"{book_rel}: 该书已有 {practice_n} 条学生练习记录引用旧卡片，"
                        f"重插会级联删除这些数据。请改用全量重载"
                        f"（pipeline --purge-business-data）或先人工处理业务数据")
                if cards_n > 0:
                    deleted = self._replace_semester_cards(sem_id)
                    print(f"[replace] {book_rel}: 清除该书已入库的 {deleted} 张卡，重新插入",
                          flush=True)
            lesson_sort: dict[int, int] = {}
            count = 0
            unmatched = 0
            # 页码锚定：确定性章归属（重处理任意页不影响结构；无锚退化）
            anchor_ctx = self._build_anchor_ctx(toc_path, cards, sem_id)
            anchor_stats = {"corrected": 0, "disambiguated": 0, "normalized": 0}
            for c in cards:
                lid = c.get("lesson_id")
                lesson_id_db = None
                if anchor_ctx is not None:
                    lesson_id_db, action = self._anchor_lesson_id(c, anchor_ctx)
                    if action:
                        anchor_stats[action] += 1
                if lesson_id_db is None:
                    if not lid:
                        unmatched += 1
                        continue
                    lesson_id_db = self._match_lesson_scoped(lid, sem_id)
                if lesson_id_db is None:
                    # 尝试去掉首尾空格
                    lid_stripped = lid.strip()
                    if lid_stripped != lid:
                        lesson_id_db = self._match_lesson_scoped(lid_stripped, sem_id)
                if lesson_id_db is None:
                    # 子节归并：N.M.K 子节（如 21.2.2 公式法）归并到父节 N.M（21.2 解一元二次方程），
                    # 因为 DB 骨架按 TOC 只建到 N.M 一级
                    lesson_id_db = self._match_parent_lesson(lid, sem_id)
                if lesson_id_db is None:
                    print(f"[WARN] card lesson_id={lid!r} not found in DB, skipped", flush=True)
                    unmatched += 1
                    continue
                lesson_sort[lesson_id_db] = lesson_sort.get(lesson_id_db, 0) + 1
                self._insert_card(lesson_id_db, lesson_sort[lesson_id_db], c)
                count += 1
            if unmatched:
                print(f"[WARN] {unmatched} card(s) could not be matched to any lesson", flush=True)
            if anchor_ctx is not None:
                print(f"[anchor] {book_rel}: offset={anchor_ctx[0].offset}, "
                      f"corrected={anchor_stats['corrected']}, "
                      f"disambiguated={anchor_stats['disambiguated']}, "
                      f"normalized={anchor_stats['normalized']}", flush=True)
            self._conn.commit()
            return count

        subject_code = self._subject_code_by_name(info["subject"])
        gb = GRADE_BAND_MAP[info["grade_band"]]
        grade_code = grade_to_code(info["grade"])
        term_code = TERM_MAP[info["term"]]
        edition = edition_from_book_name(info["book"])
        tv = self._find_or_create_textbook_version(subject_code, info["publisher"], gb, edition)
        sem = self._find_or_create_semester(tv, grade_code, term_code, f"{info['grade']}{info['term']}")

        # 预扫章综述标签（章标题），用于 unit.name
        overview_label: dict[int, str] = {}
        for c in cards:
            p = parse_lesson_id(c.get("lesson_id"))
            if p and p["is_overview"]:
                overview_label.setdefault(p["chapter"], c["lesson_id"])

        # 按 lesson 出现序分组
        order: list[str] = []
        grouped: dict[str, list[dict]] = {}
        for c in cards:
            lid = c.get("lesson_id")
            if lid not in grouped:
                grouped[lid] = []
                order.append(lid)
            grouped[lid].append(c)

        unit_ord: dict[int, int] = {}  # chapter -> 已分配的节序（不含综述 0）
        touched_units: set[int] = set()
        count = 0
        for lid in order:
            p = parse_lesson_id(lid)
            if p is None:
                # 防御：未解析的 label（理论上 extract 已继承非 null），跳过
                continue
            chapter = p["chapter"]
            unit_name = overview_label.get(chapter, f"第{chapter}章")
            unit_id = self._find_or_create_unit(sem, chapter, unit_name)
            touched_units.add(unit_id)
            if p["is_overview"]:
                lesson_sort = 0
            else:
                lesson_sort = unit_ord.get(chapter, 0) + 1
                unit_ord[chapter] = lesson_sort
            lesson_id_db = self._find_or_create_lesson(unit_id, lid, lesson_sort)
            for i, c in enumerate(grouped[lid], 1):
                self._insert_card(lesson_id_db, i, c)
                count += 1
        self._conn.commit()
        # 重排涉及 unit 的 sort_order，防止新旧 lesson 顺序错乱或重复
        for uid in touched_units:
            self._renumber_lessons(uid)
        return count

    def _insert_card(self, lesson_id: int, sort_order: int, c: dict):
        cm = c.get("content_metadata")
        card_content = c.get("content") or ""
        card_type = c.get("card_type")

        # practice 卡：从 content_metadata 提取 groups 做子串校验
        # （extract_cli 写入 groups，publish_cli 追加 images 等）
        if cm and cm.get("groups") is not None:
            groups = cm.get("groups")
            existing = {k: v for k, v in cm.items() if k != "groups"}
            # 子串校验在重组前对原文做（§5.2）
            cm = build_content_metadata(groups, card_content, existing)
            # practice 卡 content 重组：用已验证的 groups 重建 content
            # 每题独立成段，LLM 兜底正则拆不开的边缘案
            validated_groups = cm.get("groups") if cm else None
            if card_type == "practice" and validated_groups:
                card_content = rebuild_practice_content(validated_groups)

        kp = c.get("knowledge_point_ids") or []
        self._exec(
            "INSERT INTO cards (lesson_id, sort_order, card_type, title, content, "
            "content_metadata, knowledge_point_ids, textbook_page) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
            (lesson_id, sort_order, card_type, c.get("title"), card_content,
             json.dumps(cm, ensure_ascii=False) if cm else None,
             json.dumps(kp, ensure_ascii=False),
             c.get("textbook_page")),
        )

    def load_questions(self, questions: list[dict]) -> int:
        count = 0
        for q in questions:
            sid = self._subject_id_by_code(normalize_subject(q.get("subject_id")))
            opts = q.get("options")
            content = q.get("content") or ""
            chash = content_hash(content)
            # 去重：content_hash 命中已有题则复用，跳过插入（PRD §7.10）
            if self._query("SELECT id FROM questions WHERE content_hash=%s LIMIT 1", (chash,)):
                continue
            self._exec(
                "INSERT INTO questions (subject_id, group_id, group_order, type, difficulty, "
                "content, options, answer, explanation, material_text, material_url, "
                "grade_band, source, source_year, content_hash) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (sid, q.get("group_id"), q.get("group_order"), q.get("type"), q.get("difficulty"),
                 content,
                 json.dumps(opts, ensure_ascii=False) if opts is not None else None,
                 q.get("answer") or "", q.get("explanation"), q.get("material_text"),
                 q.get("material_url"), q.get("grade_band"), q.get("source"), q.get("source_year"),
                 chash),
            )
            count += 1
        self._conn.commit()
        return count
