import re

from subject_strategies.chinese_inline_material import split_inline_material


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


Q14 = (
    "联系《醉翁亭记》及下面材料，在后面语段的横线上填写恰当的内容。(3分)\n"
    "予以罪废①，无所归，扁舟吴中。一日过郡学，东顾草树郁然，崇阜②广水，不类乎城中。"
    "予爱而徘徊，遂以钱四万得之，构亭北辟③，号“沧浪”焉。予时榜④小舟，幅巾⑤以往，"
    "至则洒然忘其归。觞而浩歌，踞而仰啸，野老不至，鱼鸟共乐。形骸既适则神不烦，"
    "观听无邪则道以明。返思向之汩汩荣辱之场，日与锱铢利害相磨戛⑥，隔此真趣，不亦鄙哉！\n"
    "（取材于苏舜钦《沧浪亭记》）\n"
    "注：①罪废：因获罪被罢官 ②崇阜：高山 ③琦（qí）：曲折的堤岸 ④榜（bàng）：划船 "
    "⑤幅巾：以丝巾裹头，指着便装 ⑥磨戛（jiá）：摩擦碰撞欧阳修与苏舜钦同处贬谪之境，"
    "都借山水安顿身心，但“乐”的内涵不同。"
    "苏舜钦在沧浪亭中时而放声高歌，时而蹲坐长啸，没有村野老人来访，唯有“ ①”，"
    "这种远离官场的生活令他形骸安适、心神清宁，所见所闻皆“ ② ”，"
    "对道义的体悟也愈发清明通透。而欧阳修的太守之“乐”，不止于山间朝暮四时的景致之美，"
    "更深一层在于 ③"
)


def test_q14_splits_note_and_answer_paragraph():
    material, rest = split_inline_material(Q14)
    assert material is not None
    assert material.startswith("联系《醉翁亭记》")
    assert "注：①罪废" in material
    assert material.rstrip().endswith("但“乐”的内涵不同。")
    assert rest.startswith("苏舜钦在沧浪亭中")
    assert _norm(material + rest) == _norm(Q14)


def test_note_is_on_its_own_line():
    material, _ = split_inline_material(Q14)
    assert "\n注：①罪废" in material


def test_no_lead_no_split():
    content = "下列加点字意思都相同的一项是(2分)\n" + "A.甲 B.乙 C.丙 D.丁。" * 12
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content


def test_bare_material_marker_without_lead_no_split():
    content = "材料：这是一段说明文字，讲的是城市与河流的关系。" + "请简要概括本文的中心论点。" * 8
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content


def test_short_content_no_split():
    content = "请联系下面材料作答。"
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content


def test_link_material_marker_splits():
    content = (
        "请结合下面的链接材料，说说你对文章第④段画线句的理解。(3分)\n\n"
        "【链接材料】：上世纪初，青年毛泽东在刻苦读书的岁月中，一直坚持“自讨苦吃”。"
        "烈日炎炎的盛夏，别人待在寝室摇扇避暑，他却赤背顶着骄阳暴晒。\n\n"
        "结合材料，谈谈你的理解。"
    )
    material, rest = split_inline_material(content)
    assert material is not None
    assert "【链接材料】" in material
    assert rest.startswith("结合材料")
    assert _norm(material + rest) == _norm(content)


# 海淀 5677 实测：注释是「③[弄儿]逗小孩。」这种方括号、无冒号体例；
# 旧实现只认「①词：释义」，把切点落在上一条释义的句号上，半截注释变题干。
Q_BRACKET_NOTE_TAIL = (
    "后世认为李白的《行路难》虽然受到鲍照《拟行路难》的影响，但是诗人的情感不尽相同。"
    "请结合诗歌具体内容，简要分析两首诗情感的异同。(3 分)\n"
    "拟行路难(其六) 鲍照①\n"
    "对案不能食，拔剑击柱长叹息。\n"
    "丈夫生世会几时？安能蹀躞②垂羽翼！\n"
    "自古圣贤尽贫贱，何况我辈孤且直①!\n"
    "注：①[鲍照](约414-466)南朝宋文学家，出身寒门庶族。"
    "②[蹀躞](diéxiè)：小步行走的样子。这句是说：怎么能裹足不前，垂翼不飞？"
    "③[弄儿]逗小孩。④[孤且直]孤高并且耿直。"
)


def test_bracket_style_note_at_end_does_not_split():
    """注块是最后一段、后面没有设问 → 整段不动，绝不能切出「注释题干」。"""
    material, rest = split_inline_material(Q_BRACKET_NOTE_TAIL)
    assert material is None
    assert rest == Q_BRACKET_NOTE_TAIL


def test_bracket_style_note_with_stem_after_splits():
    content = Q_BRACKET_NOTE_TAIL + "\n请结合注释，分析诗人的情感。(3分)"
    material, rest = split_inline_material(content)
    assert material is not None
    assert material.endswith("④[孤且直]孤高并且耿直。")
    assert rest.startswith("请结合注释")
    assert _norm(material + rest) == _norm(content)
