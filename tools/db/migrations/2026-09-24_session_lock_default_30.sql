-- 日期：2026-09-24 主旨：单次学习锁定默认 30 分钟（列默认值 + 存量 NULL 回填）
-- 设计：docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md §4.1；用户 2026-09-24 裁决
--
-- 做什么：
--   1. `controls.session_lock_minutes` 的**列默认值**从 NULL 改成 30 —— 新建 controls 行
--      （`ControlsRepository.ensure()` 只插 student_id）从此默认带 30 分钟锁。
--   2. 存量 `NULL` **回填成 30** —— 用户原话「应该先固定一下默认的锁定时长，现在的默认锁定时长是没有填的」。
--      回填范围只含「从未设过」的行；家长显式设过的值（如 10）不受影响。
--
-- 语义没变：`NULL` 仍然是「**未设锁**」（学生可自由登出）。家长在 `/parent/controls`
-- 把输入框**清空并保存**，仍然会把这一列写回 NULL（= 解除设置）。本次只是把**默认值**填上。
--
-- 幂等：改默认值可重复执行；回填用 `WHERE session_lock_minutes IS NULL`，第二次跑影响 0 行。
-- 回滚：
--   ALTER TABLE controls MODIFY COLUMN session_lock_minutes SMALLINT DEFAULT NULL COMMENT '…';
--   （回填过的 30 无法逐行还原——执行前请自行确认是否存在「家长想保持未设锁」的行）

-- ── 1. 列默认值 → 30 ──
ALTER TABLE controls
  MODIFY COLUMN session_lock_minutes SMALLINT DEFAULT 30
  COMMENT '单次学习锁定分钟数（1..480）：学生登录起该时间内禁止登出；NULL = 家长显式解除设置（未设锁）；默认 30';

-- ── 2. 存量 NULL 回填 30 ──
UPDATE controls SET session_lock_minutes = 30 WHERE session_lock_minutes IS NULL;
