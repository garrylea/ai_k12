-- 材料抽取方式留痕（2026-11-02）：rule | llm | manual；NULL = 未做材料抽取。
-- 用于排查「这条 material_text 是规则切的还是 LLM 切的」，不参与业务逻辑。
ALTER TABLE questions
  ADD COLUMN material_method VARCHAR(8) DEFAULT NULL
    COMMENT '材料抽取方式：rule|llm|manual；NULL=未做材料抽取（无材料题或未处理）'
    AFTER material_url;
