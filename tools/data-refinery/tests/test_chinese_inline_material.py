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


def test_q14_lead_becomes_stem_note_and_paragraph_stay_in_material():
    """2026-11-21 用户裁决：做题要求作题干；材料+注+填充语段全进 material_text。"""
    material, rest = split_inline_material(Q14)
    assert material is not None
    assert rest == "联系《醉翁亭记》及下面材料，在后面语段的横线上填写恰当的内容。(3分)"
    assert material.startswith("予以罪废")
    assert "注：①罪废" in material
    assert material.rstrip().endswith("更深一层在于 ③")
    assert _norm(rest + material) == _norm(Q14)


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


def test_bracket_style_note_at_end_splits_stem_from_material():
    """注块在末尾、题干在首段：切成「题干 + 材料(诗+注)」，绝不把注切进题干。

    2026-11-21 起由「题干在前」规则处理：旧实现只认材料在前，此处整段不切、
    诗和注全并进题干。现在首段（设问）留在题干，诗+注归材料。
    """
    material, rest = split_inline_material(Q_BRACKET_NOTE_TAIL)
    assert material is not None
    assert material.startswith("拟行路难")
    assert "注：①[鲍照]" in material
    assert rest.startswith("后世认为李白的《行路难》")
    assert _norm(rest + material) == _norm(Q_BRACKET_NOTE_TAIL)


def test_pure_material_block_without_stem_not_split():
    """整段只有诗+注、首段不是设问 → 不是「题干在前」，不能切。"""
    content = (
        "拟行路难(其六) 鲍照①\n"
        "对案不能食，拔剑击柱长叹息。丈夫生世会几时？安能蹀躞②垂羽翼！\n"
        "弃置罢官去，还家自休息。朝出与亲辞，暮还在亲侧。\n"
        "弄儿床前戏，看妇机中织。自古圣贤尽贫贱，何况我辈孤且直①!\n"
        "注：①[鲍照]南朝宋文学家。②[蹀躞]小步行走的样子。"
    )
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content


def test_bracket_style_note_with_stem_after_splits():
    content = Q_BRACKET_NOTE_TAIL + "\n请结合注释，分析诗人的情感。(3分)"
    material, rest = split_inline_material(content)
    assert material is not None
    assert material.endswith("④[孤且直]孤高并且耿直。")
    assert rest.startswith("请结合注释")
    assert _norm(material + rest) == _norm(content)


# ── 2026-11-21 回归：西城模拟二 Q8/Q15 及同类体例 ─────────────────────
# 这批题此前材料整段并进题干：注释块只认 `注：`、切点贪到语段、题干在前无规则。

Q8_STEM_THEN_MATERIAL = (
    "班会的最后，小文写了一段话，在这段话中，她想引用古诗词来鼓励好友。"
    "根据文段内容，下面选项中最恰当的一项是(1分)\n"
    "面临人生第一次大考，你的焦虑如春蚕破茧前的阵痛，并不会阻碍你向上生长。"
    "不要忘记，那些在题海中拼搏的日子，都在为此刻的绽放积蓄力量。“ ”，"
    "当你走过一段又一段崎岖的长路，会惊喜地发现，理想已触手可及。"
)


def test_q8_stem_then_material_splits():
    """题干在前、材料在后、无注释块：材料是后缀，题干是首段。"""
    material, rest = split_inline_material(Q8_STEM_THEN_MATERIAL)
    assert material is not None
    assert material.startswith("面临人生第一次大考")
    assert rest.startswith("班会的最后")
    # 材料是后缀，题干在前：按原文顺序拼回应是 rest + material
    assert _norm(rest + material) == _norm(Q8_STEM_THEN_MATERIAL)


def test_dictionary_one_liner_not_split():
    """字典释义题一行到底，不能当「题干+材料」切。"""
    content = (
        "同学们查阅《现代汉语词典》，找到“韵律”的两个解释："
        "①指诗词中的平仄格式和押韵规则；②指语言或物体运动的节奏规律。"
        "根据文段内容及词典释义，下列对“景观韵律”的理解正确的一项是()"
    )
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content


Q15_XICHENG = (
    "根据《曹刿论战》及下面的材料，在后面语段中的横线上填写恰当的内容。(3分)\n"
    "晋侯<sup>①</sup>始入而教其民，二年，欲用之<sup>②</sup>。子犯曰：“民未知义，未安其居。”"
    "于是乎出定襄王③，入务利民④，民怀生矣。……一战而霸，文之教也。\n"
    "（取材于《左传·僖公二十七年》）\n"
    "[注释]①晋侯：晋文公重耳。②用之：用百姓打仗。③出定襄王：出外帮周襄王稳固王位。"
    "④入务利民：回国做对百姓有利的事情。⑤伐原：晋文公攻打原国。⑥共：同“恭”，恭敬之心。"
    "⑦大蒐(sōu)：阅兵式。⑧听不惑：听到事情后能明辨是非。\n"
    "要在对外作战中取胜，修明内政是关键。曹刿“ ① ”的话语，让鲁庄公意识到"
    "诚心断案、赢得百姓信任是作战可凭借的条件。"
)


def test_q15_lead_becomes_stem_with_bracket_note_in_material():
    """`[注释]` 体例：做题要求作题干，注释与填充语段都留在 material_text。"""
    material, rest = split_inline_material(Q15_XICHENG)
    assert rest == "根据《曹刿论战》及下面的材料，在后面语段中的横线上填写恰当的内容。(3分)"
    assert material is not None
    assert material.startswith("晋侯")
    assert "[注释]" in material
    assert material.rstrip().endswith("诚心断案、赢得百姓信任是作战可凭借的条件。")
    assert _norm(rest + material) == _norm(Q15_XICHENG)


Q15_CHENJINGLUN = (
    "根据《醉翁亭记》及下面的材料，在后面语段中的横线上填写恰当的内容。(2 分)\n"
    "尚书司门员外郎晋国裴君治抚①之二年，因城之东隅作台以游，而命之曰“拟岘台”。"
    "数与其属与州之寄客③者游，而间独求记于予。\n"
    "（取材于曾巩《拟岘台记》，有删改）\n"
    "【注释】①治抚：治理抚州。②拟：类似 ③寄客：寄居的客人 ④数：多次\n"
    "欧阳修在《醉翁亭记》中，通过描绘滁人出游、太守宴饮、①的热闹场景，"
    "衬托出自己的为政之道。曾巩在《拟岘台记》中，通过记述州民的变化，"
    "直接肯定了裴君③的治理方式。"
)


def test_chenjinglun_lead_becomes_stem_material_keeps_full_text():
    """`【注释】` 末条无句号：做题要求作题干，材料连同末条注释与语段保留在 material_text。"""
    material, rest = split_inline_material(Q15_CHENJINGLUN)
    assert rest.startswith("根据《醉翁亭记》及下面的材料")
    assert material is not None
    assert material.startswith("尚书司门员外郎")
    assert "④数：多次" in material
    assert material.rstrip().endswith("直接肯定了裴君③的治理方式。")
    assert _norm(rest + material) == _norm(Q15_CHENJINGLUN)


Q15_35ZHONG = (
    "阅读链接材料，在后面语段中的横线上填写恰当的内容。(4 分)\n"
    "西望武昌诸山，冈陵起伏，草木行列，烟消日出。渔夫樵父之舍皆可指数①。"
    "此其所以为快②哉者也。……（取材于苏辙《黄州快哉亭记》）\n"
    "注释：①指数：用手指清点。②快：畅快。③睥睨，斜视的样子，引申为傲视。"
    "④骋骛，驰骋疆场。⑤使其中不自得，将何往而非病：如果心中不能自得其乐，"
    "到哪里没有忧愁？⑥以物伤性：因外物而影响本性。⑦适：往，去。\n"
    "“内核稳定”指一个人在面对外界纷繁复杂的压力与挑战时，能够坚守内心的平静"
    "与稳定。这一点在《岳阳楼记》中表现为古仁人的“①”。"
)


def test_35zhong_comment_then_paragraph_starting_with_quote_not_blocked():
    """语段以「“X”指…」开头时，不能误判成注释续写而不切。"""
    material, rest = split_inline_material(Q15_35ZHONG)
    assert material is not None
    assert material.rstrip().endswith("⑦适：往，去。")
    assert rest.startswith("“内核稳定”指")
    assert _norm(material + rest) == _norm(Q15_35ZHONG)


Q15_HAIDIAN_SINGLE_NOTE = (
    "根据上文及下面材料，在后面语段的横线处填写恰当的内容。(4分)\n"
    "去胥门九里，有村曰横塘。山夷水旷，溪桥映带村落间，颇不乏致。"
    "予过此，觉城市渐远，湖山可亲，意思豁然，风日亦为清朗。"
    "（取材于李流芳《江南卧游册题词·横塘》）\n"
    "[注] 阻风：舟行因风受阻。\n"
    "作者绘山水，述往事，寄深情。张岱雪夜独往湖心亭，领略雪湖奇景后，"
    "又经历了①的奇遇，在回忆中感受到世事变迁的况味。"
)


def test_haidian_single_note_without_circles_splits():
    """单条 `[注]` 无圈号：语段里的 ① 不能被当成注条目。"""
    material, rest = split_inline_material(Q15_HAIDIAN_SINGLE_NOTE)
    assert rest == "根据上文及下面材料，在后面语段的横线处填写恰当的内容。(4分)"
    assert material is not None
    # 做题要求作题干；材料 + 单条注 + 填充语段都留在 material_text。
    assert material.startswith("去胥门九里")
    assert "[注] 阻风：舟行因风受阻。" in material
    assert material.rstrip().endswith("在回忆中感受到世事变迁的况味。")
    assert _norm(rest + material) == _norm(Q15_HAIDIAN_SINGLE_NOTE)


def test_option_block_with_space_not_treated_as_material():
    """OCR 丢了选项点号（`A 词前小序…`）：选项块不能被当成材料切走。"""
    content = (
        "下列对这首词的内容理解和分析不正确的一项是(2分)\n"
        "A 词前小序“丙辰中秋，欢饮达旦”，交代了写作的时间及缘由。\n"
        "B “转朱阁，低绮户，照无眠”借月亮移动，暗示夜已深沉。\n"
        "C “人有悲欢离合，月有阴晴圆缺”，体现了词人郁闷伤感的情感。\n"
        "D “不应有恨，何事长向别时圆”，含蓄表达对不幸离人们的同情。"
    )
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content


def test_note_definition_continuation_not_split():
    """注的释义跨句（`……句子。意思为，……`）：不能把「意思为…」当语段切出。"""
    content = (
        "为了庆祝中华人民共和国成立75周年，学校举办了一次朗诵会。"
        "其中有一位同学选择了毛泽东的《七律·人民解放军占领南京》，并写了朗读脚本，"
        "其中不正确的一项是()\n"
        "钟山风雨起苍黄，百万雄师过大江。虎踞龙盘今胜昔，天翻地覆慨而慷。\n"
        "宜将剩勇追穷寇，不可沽名学霸王。天若有情天亦老①，人间正道是沧桑。\n"
        "注释：①引用唐代李贺《金铜仙人辞汉歌》句子。意思为，自然界如果有知，"
        "它会体察到兴盛与衰败这条不可改变的法则。"
    )
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content


def test_leaded_instruction_first_paragraph_becomes_stem():
    """新规则（最高优先级）：首段做题要求 → content；其余（材料+注释+语段）→ material_text。"""
    content = (
        "根据《曹刿论战》及下面的材料，在后面语段中的横线上填写恰当的内容。(3分)\n"
        "晋侯始入而教其民，二年，欲用之。子犯曰：“民未知义，未安其居。”于是乎出定襄王，"
        "入务利民，民怀生矣。\n"
        "[注释]①晋侯：晋文公重耳。②用之：用百姓打仗。③出定襄王：帮周襄王稳固王位。\n"
        "要在对外作战中取胜，修明内政是关键。曹刿“ ① ”的话语，让鲁庄公意识到"
        "诚心断案、赢得百姓信任是作战可凭借的条件。\n"
    )
    material, rest = split_inline_material(content)
    assert rest == "根据《曹刿论战》及下面的材料，在后面语段中的横线上填写恰当的内容。(3分)"
    assert material is not None
    assert material.startswith("晋侯始入")
    assert "[注释]" in material
    assert material.rstrip().endswith("诚心断案、赢得百姓信任是作战可凭借的条件。")
    assert _norm(rest + material) == _norm(content)


def test_leaded_para_without_score_falls_through():
    """首段没有（N分）分值 → 不触发做题要求规则，交后续规则处理。"""
    content = (
        "根据下面的材料，回答问题。\n"
        "这是一段足够长的说明文字，讲的是城市与河流的关系，内容具体而有条理，"
        "包含若干可以被分析的事实与细节。" * 3
    )
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content


def test_answer_scaffold_rest_falls_through_to_stem_first():
    """语段只剩「答:」时不算后继设问；改走「题干在前」把传记材料切出来。"""
    content = (
        "根据对《岳阳楼记》中“先天下之忧而忧，后天下之乐而乐”的理解，"
        "概括下列材料中范仲淹践行这种忧乐观的行为还有哪些。(3分)\n"
        "范仲淹，字希文，少有志操。康定元年，元吴反，延州诸砦多失守，"
        "仲淹自请行，迁户部郎中兼知延州。大兴营田，且听民得互市，以通有无。"
        "以民远输劳苦，请建鄜城为军，以河中、同、华中下户税租就近输之。\n"
        "《宋史·范仲淹传》(节选)\n"
        "【注】①〔砦〕同“寨”②〔互市〕民族或国家之间的贸易活动。\n"
        "答:"
    )
    material, rest = split_inline_material(content)
    assert material is not None
    assert material.startswith("范仲淹")
    assert rest.startswith("根据对《岳阳楼记》")
    assert _norm(rest + material) == _norm(content)


# ── 2026-11-22 回归：做题要求末词写「内容」时也要命中 ───────────────────
# 西城 2026 模拟二 Q11（q7609）：首行「根据你的理解，在下面横线处填写恰当的内容。(2分)」。
# 原词表只认「材料/语段/…」→ 整段不切、填充语段残留题干；扩词后应切成「要求 + 语段」。
Q11_JIANDJIA = (
    "根据你的理解，在下面横线处填写恰当的内容。(2分)\n"
    "《蒹葭》情韵悠远，最宜在诵读中体会其意境与情感。诵读“蒹葭苍苍，白露为霜”，"
    "语速放缓，重音落在“苍苍”“为霜”上，表现深秋①的氛围；诵读“溯洄从之，道阻且长”，"
    "“道阻”“且长”间稍作停顿，语调沉缓，读出诗人追寻之路的②进而体会他深沉的情感。"
)


def test_lead_para_ending_with_neirong_splits():
    """做题要求末词是「内容」而非「材料/语段」时，同样切成「要求作题干 + 语段进材料」。"""
    material, rest = split_inline_material(Q11_JIANDJIA)
    assert rest == "根据你的理解，在下面横线处填写恰当的内容。(2分)"
    assert material is not None
    assert material.startswith("《蒹葭》情韵悠远")
    assert material.rstrip().endswith("进而体会他深沉的情感。")
    assert _norm(rest + material) == _norm(Q11_JIANDJIA)


def test_sorting_stem_without_below_marker_not_split():
    """排序题 q7602 用「语境/语句」且无「下面/上述」→ 不在本次扩词范围，保持不切。"""
    content = (
        "根据语境，在横线出补写语句，排序恰当的一项是(2分)\n"
        "①在指尖划过操控台的瞬间，那些你在课本里读到的太空探测成了触手可及的真实体验"
        "②当目光扫过排列整齐的长征系列火箭，几代航天人接力奋斗的脉络在你眼前逐渐清晰"
        "③看屏幕上航天员漂浮的身影，让你明白“上九天揽月”的浪漫早已变成了鲜活的现实"
    )
    material, rest = split_inline_material(content)
    assert material is None
    assert rest == content
