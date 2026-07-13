"""db_loader：把 published JSONL 加载进 MySQL，并派生教材结构（textbook_versions/semesters/units/lessons）。

本模块拆分为：
- 纯函数（subject 归一、rel_path 解析、中文数字、lesson_id 解析、sort_order 重排）：可单测。
- DbLoader 类：连库、find-or-create 结构、入库 cards/questions（集成测试覆盖）。
"""

import re
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


# ---------- DbLoader ----------

import json  # noqa: E402

import pymysql  # noqa: E402


class DbLoader:
    """连 MySQL，find-or-create 教材结构，入库 cards/questions。

    幂等：textbook_versions/semesters/units/lessons 用 find-or-create（按唯一键查再插）；
    cards/questions 用 full-reload（reset_* 先 DELETE 再重插）。
    """

    def __init__(self, host: str, port: int, user: str, password: str, db: str):
        self._conn = pymysql.connect(host=host, port=port, user=user,
                                     password=password, database=db, charset="utf8mb4")
        self._subj_name: dict[str, tuple] = {}   # name -> (id, code)
        self._subj_code: dict[str, int] = {}     # code -> id
        self._tv: dict[str, int] = {}            # code -> id
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
    def _find_or_create_textbook_version(self, subject_code: str, publisher: str, grade_band: str) -> int:
        code = f"{subject_code}_{publisher}_{grade_band}"
        if code in self._tv:
            return self._tv[code]
        row = self._query("SELECT id FROM textbook_versions WHERE code=%s", (code,))
        if row:
            self._tv[code] = row[0][0]
            return row[0][0]
        self._exec(
            "INSERT INTO textbook_versions (subject_id, name, code, grade_band, publisher, is_active) "
            "VALUES (%s,%s,%s,%s,%s,1)",
            (self._subject_id_by_code(subject_code), publisher, code, grade_band, publisher),
        )
        tid = self._query("SELECT id FROM textbook_versions WHERE code=%s", (code,))[0][0]
        self._tv[code] = tid
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

    # --- 入库 ---
    def load_book_cards(self, book_rel: str, cards: list[dict]) -> int:
        info = parse_book_rel_path(book_rel)
        if not info:
            raise ValueError(f"无法解析教材 rel_path: {book_rel!r}")
        subject_code = self._subject_code_by_name(info["subject"])
        gb = GRADE_BAND_MAP[info["grade_band"]]
        grade_code = grade_to_code(info["grade"])
        term_code = TERM_MAP[info["term"]]
        tv = self._find_or_create_textbook_version(subject_code, info["publisher"], gb)
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
        count = 0
        for lid in order:
            p = parse_lesson_id(lid)
            if p is None:
                # 防御：未解析的 label（理论上 extract 已继承非 null），跳过
                continue
            chapter = p["chapter"]
            unit_name = overview_label.get(chapter, f"第{chapter}章")
            unit_id = self._find_or_create_unit(sem, chapter, unit_name)
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
        return count

    def _insert_card(self, lesson_id: int, sort_order: int, c: dict):
        cm = c.get("content_metadata")
        kp = c.get("knowledge_point_ids") or []
        self._exec(
            "INSERT INTO cards (lesson_id, sort_order, card_type, title, content, "
            "content_metadata, knowledge_point_ids, textbook_page) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
            (lesson_id, sort_order, c.get("card_type"), c.get("title"), c.get("content"),
             json.dumps(cm, ensure_ascii=False) if cm else None,
             json.dumps(kp, ensure_ascii=False),
             c.get("textbook_page")),
        )

    def load_questions(self, questions: list[dict]) -> int:
        count = 0
        for q in questions:
            sid = self._subject_id_by_code(normalize_subject(q.get("subject_id")))
            opts = q.get("options")
            self._exec(
                "INSERT INTO questions (subject_id, group_id, group_order, type, difficulty, "
                "content, options, answer, explanation, material_text, material_url, "
                "grade_band, source, source_year) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (sid, q.get("group_id"), q.get("group_order"), q.get("type"), q.get("difficulty"),
                 q.get("content"),
                 json.dumps(opts, ensure_ascii=False) if opts is not None else None,
                 q.get("answer") or "", q.get("explanation"), q.get("material_text"),
                 q.get("material_url"), q.get("grade_band"), q.get("source"), q.get("source_year")),
            )
            count += 1
        self._conn.commit()
        return count
