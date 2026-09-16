"""语文古诗文解释专项管线：**入库前自检**（纯函数，不碰网络与数据库）。

分两档，语义与 `dictation_check` 一致：

- `errors`   → 致命，该篇**不进 JSONL、不入库**，进过目清单的「未通过」段
- `warnings` → 不致命（如某字词在正文里找不到被丢弃），照常入库，但要让人看见

**为什么 `errors` 必须 fail-closed**：切句拼不回正文、译文缺失、字词下标越界，
这几类错误会直接把学生的答题页弄坏（少一句、空一段、字词挂在别的句上）。
宁可整篇不入库等人工看，也不要半截数据进库后静默生效。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from interpretation_split import join_sentences, term_plain


@dataclass
class CheckResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def check_passage(
    *,
    body: str,
    sentences: list[str],
    translations: list[str],
    key_terms: list[dict],
    full_translation: str | None,
    require_translation: bool = True,
) -> CheckResult:
    """对一篇的解释数据做自检。

    `require_translation=False` 用于「只校验字词与切句」的场景（如导出校对稿复核）。
    """
    r = CheckResult()

    if not body.strip():
        r.errors.append("正文为空（库里该篇的 body 是空的，先修正文）")
        return r

    # ---- 1. 切句不变式（最关键的一条）----
    joined = join_sentences(sentences)
    if joined != body:
        r.errors.append(
            f"切句拼不回正文（拼接 {len(joined)} 字 vs 正文 {len(body)} 字）"
            "——说明正文里有本管线没覆盖的形态，需人工看"
        )

    if not sentences:
        r.errors.append("句数为 0")
    for i, s in enumerate(sentences):
        if not s.strip():
            r.errors.append(f"第 {i} 句为空（或只有空白）")

    # ---- 2. 字词 ----
    if not key_terms:
        # 不是错误：某篇可能一个重点字词都没有（用户没给），照样能练「逐句翻译」
        r.warnings.append("该篇没有任何重点字词（只有逐句翻译）")
    for i, t in enumerate(key_terms):
        term = str(t.get("term", ""))
        gloss = str(t.get("gloss", ""))
        idx = t.get("sentenceIndex")
        if not term:
            r.errors.append(f"第 {i} 条字词的 term 为空")
        if not gloss.strip():
            r.errors.append(f"字词「{term}」的解释为空")
        if not isinstance(idx, int) or isinstance(idx, bool):
            r.errors.append(f"字词「{term}」的 sentenceIndex 不是整数")
        elif idx < 0 or idx >= len(sentences):
            r.errors.append(f"字词「{term}」的 sentenceIndex={idx} 越界（共 {len(sentences)} 句）")
        elif term and term_plain(term) not in sentences[idx] and term not in sentences[idx]:
            # 归属算法保证这条成立；不成立说明上游被改坏了。
            # 判据用去注音形式：词本身带拼音（`谪（zhé）守`），正文里只有「谪守」。
            r.errors.append(f"字词「{term}」不在它所归属的第 {idx} 句里")

    # ---- 3. 译文（混合模式：输入给了用输入的，没给由模型生成）----
    if require_translation:
        if len(translations) != len(sentences):
            r.errors.append(f"译文条数 {len(translations)} 与句数 {len(sentences)} 不一致")
        for i, tr in enumerate(translations):
            if not str(tr).strip():
                r.errors.append(f"第 {i} 句的译文为空")
        if not (full_translation or "").strip():
            r.errors.append("全文译文为空")

    return r
