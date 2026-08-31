-- 2026-08-31 教材版本增加 edition（版次）维度
-- 背景：同一出版社不同课标版次的教材（如人教版 2012 课标 vs 2022 课标修订的九上数学）
-- 此前仅由 (subject, publisher, grade_band) 唯一确定 textbook_version，两版会落到同一
-- semester 互相覆盖卡片、混合骨架。加 edition 列（db_loader 从书名前导括号提取，如
-- 「（根据2022年版课程标准修订）义务教育教科书·数学九年级上册」->「根据2022年版课程标准修订」；
-- 无前导括号 = 旧版，edition=''），4 元组唯一。
-- 兼容性：存量行 edition 取默认 ''，与 db_loader 对无标记书名的推导一致，无需回填。

ALTER TABLE textbook_versions
  ADD COLUMN edition VARCHAR(50) NOT NULL DEFAULT '' AFTER publisher,
  ADD UNIQUE KEY uniq_textbook_versions_edition (subject_id, publisher, grade_band, edition);
