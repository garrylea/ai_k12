-- 2026-09-20 safety_alerts：管理员手动清理 30 天前预警的两个索引
--
-- 做什么：
--   1) idx_sa_parent_created (parent_id, created_at) —— 家长端**全量**列表
--   2) idx_sa_created_at     (created_at)            —— 本次新增的保留期清理
--
-- 为什么：
--   * 全量列表 `WHERE parent_id=? ORDER BY created_at DESC, id DESC` 此前只有
--     (parent_id, is_read) 可用 → **filesort**。加了 (parent_id, created_at) 后
--     范围扫描出来的行天然按 created_at 有序，排序可省（实测 EXPLAIN 计划树无 Sort 节点）。
--   * ⚠️ **带 `is_read = 0` 过滤的「只看未读」变体不在此列**：`WHERE parent_id=? AND is_read=0
--     ORDER BY created_at DESC, id DESC` 实测仍带 Sort —— 优化器选了更选择性的既有
--     `idx_sa_parent_unread (parent_id, is_read)` 再排序，没走本索引。**顶栏 Banner 走的正是
--     这条**（`ParentLayout.tsx` 传 `unreadOnly: true, pageSize: 1`）。要一并免掉得加
--     `(parent_id, is_read, created_at)`（会与现有 `idx_sa_parent_unread` 前缀重叠），
--     属另一批决策，本批未做。排序基数已被 `parent_id + is_read` 收窄，实际代价有限。
--   * 本次新增的 countOlderThan / deleteOlderThan 都是 `WHERE created_at < ?`，
--     无索引时是全表扫。单列 created_at 索引让它是区间扫描（实测走覆盖索引区间扫）。
--   * 写入代价可忽略：预警经 30 分钟去重窗口，每孩子每天上限约 240 条。
--
-- 幂等：两个索引各带 information_schema.STATISTICS 守卫（条件用 `> 0` 而非 `= 1`
--       ——STATISTICS 每个索引列返回一行，多列索引会返回 >1 行）；重复 apply 无副作用。
-- 回滚：ALTER TABLE safety_alerts DROP KEY idx_sa_parent_created, DROP KEY idx_sa_created_at;

-- ── 1. 家长端全量列表：(parent_id, created_at)（「只看未读」变体仍 filesort，见上）──
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safety_alerts'
    AND INDEX_NAME = 'idx_sa_parent_created'
);
SET @ddl := IF(@idx_exists > 0,
  'DO 0',
  'ALTER TABLE safety_alerts ADD KEY idx_sa_parent_created (parent_id, created_at)');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. 保留期清理：(created_at) ──
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safety_alerts'
    AND INDEX_NAME = 'idx_sa_created_at'
);
SET @ddl := IF(@idx_exists > 0,
  'DO 0',
  'ALTER TABLE safety_alerts ADD KEY idx_sa_created_at (created_at)');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
