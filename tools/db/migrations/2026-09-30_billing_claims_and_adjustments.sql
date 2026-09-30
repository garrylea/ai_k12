-- 日期：2026-09-30 主旨：订阅收费批④ —— orders 加 claim 三列 + 新表 subscription_adjustments
-- 设计：.superpowers/sdd/task-1-brief.md（spec §1）
--
-- 做什么：
--   1. orders 加三列（插在 coupon_discount_cents 之后）：家长对「付了钱但没到账」的订单
--      发起主张后，管理端裁决流转的状态载体：
--        claim_status  pending_review / rejected / approved；NULL = 从未主张
--        claimed_at    家长发起主张的时间
--        claim_note    家长附言
--      外加 KEY idx_orders_claim (claim_status, claimed_at)：管理端「待裁决列表」
--      按 status 过滤 + claimed_at 排序走这个复合索引。
--   2. 新表 subscription_adjustments：管理端两类人工干预的审计流水——
--        trial_set   直接改写 family_subscriptions.trial_ends_at（trial_ends_at 列有值）
--        grant_days  在当前期限上追加天数（delta_days 列有值）
--
-- 幂等：MySQL 9 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，
-- 每列 / 每索引前用 information_schema 守卫，不存在才执行（先例：
-- 2026-09-16_chinese_interpretation_columns.sql）；新表 CREATE TABLE IF NOT EXISTS。
-- 重复执行无副作用。
-- 回滚：
--   ALTER TABLE orders DROP INDEX idx_orders_claim;
--   ALTER TABLE orders DROP COLUMN claim_status, DROP COLUMN claimed_at, DROP COLUMN claim_note;
--   DROP TABLE subscription_adjustments;

-- ── 1. orders.claim_status ──
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'orders'
    AND COLUMN_NAME = 'claim_status'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE orders ADD COLUMN claim_status VARCHAR(12) DEFAULT NULL COMMENT ''pending_review/rejected/approved；NULL = 从未主张'' AFTER coupon_discount_cents',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. orders.claimed_at ──
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'orders'
    AND COLUMN_NAME = 'claimed_at'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE orders ADD COLUMN claimed_at DATETIME(3) DEFAULT NULL AFTER claim_status',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 3. orders.claim_note ──
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'orders'
    AND COLUMN_NAME = 'claim_note'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE orders ADD COLUMN claim_note VARCHAR(200) DEFAULT NULL AFTER claimed_at',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 4. orders 索引 idx_orders_claim（管理端待裁决列表：status 过滤 + claimed_at 排序）──
SET @has_idx := (
  SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'orders'
    AND INDEX_NAME = 'idx_orders_claim'
);
SET @ddl := IF(
  @has_idx = 0,
  'ALTER TABLE orders ADD KEY idx_orders_claim (claim_status, claimed_at)',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 5. subscription_adjustments ──
-- type 用 VARCHAR + 服务端白名单，不用 ENUM：单取值的 ENUM 就是死枚举，将来加类型要改 schema。
-- admin_id 不设外键：管理端账号表与 parents 生命周期无关，裁决流水不能随管理账号删除而丢。
CREATE TABLE IF NOT EXISTS subscription_adjustments (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  parent_id     BIGINT      NOT NULL,
  admin_id      BIGINT      NOT NULL,
  type          VARCHAR(12) NOT NULL COMMENT 'trial_set | grant_days，服务端白名单',
  trial_ends_at DATETIME(3) DEFAULT NULL COMMENT 'type=trial_set 时有值：改写后的试用截止',
  delta_days    INT         DEFAULT NULL COMMENT 'type=grant_days 时有值：追加天数（负数=扣减）',
  reason        VARCHAR(200) DEFAULT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_sub_adjust_parent (parent_id, id),
  CONSTRAINT fk_sub_adjust_parent FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
