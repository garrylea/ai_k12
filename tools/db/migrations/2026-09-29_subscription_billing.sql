-- 2026-09-29 订阅收费：套餐 / 家庭订阅 / 订单（spec 2026-09-29-subscription-billing-design.md §2）
-- 幂等：CREATE TABLE IF NOT EXISTS + 反连接回填（ODKU 裸列名在 MySQL 9.x INSERT...SELECT 下报 1052，勿加回）

CREATE TABLE IF NOT EXISTS subscription_plans (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  plan_code VARCHAR(20) NOT NULL,
  name VARCHAR(50) NOT NULL,
  price_cents INT NOT NULL,
  duration_days INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_subscription_plans_code (plan_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS family_subscriptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'trialing', -- 冗余列仅供运营 SQL；代码以 effectiveStatus 推导为准
  trial_ends_at DATETIME(3) DEFAULT NULL,
  current_period_end DATETIME(3) DEFAULT NULL,
  plan_code VARCHAR(20) DEFAULT NULL,
  source VARCHAR(10) NOT NULL DEFAULT 'trial',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_family_subscriptions_parent (parent_id),
  CONSTRAINT fk_family_subscriptions_parent FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(32) NOT NULL,
  parent_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  plan_snapshot JSON NOT NULL,
  amount_cents INT NOT NULL,
  payment_status VARCHAR(10) NOT NULL DEFAULT 'pending',
  channel VARCHAR(10) NOT NULL,
  channel_trade_no VARCHAR(64) DEFAULT NULL,
  channel_qr_content VARCHAR(255) DEFAULT NULL,
  paid_at DATETIME(3) DEFAULT NULL,
  cancelled_at DATETIME(3) DEFAULT NULL,
  expires_at DATETIME(3) NOT NULL,
  coupon_code VARCHAR(32) DEFAULT NULL,          -- 本期预留不写
  coupon_discount_cents INT DEFAULT NULL,        -- 本期预留不写
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_orders_no (order_no),
  UNIQUE KEY uk_orders_trade_no (channel_trade_no),
  KEY idx_orders_parent_status (parent_id, payment_status, id),
  CONSTRAINT fk_orders_parent FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE CASCADE,
  CONSTRAINT fk_orders_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- plans seed（占位价，上线前 UPDATE price_cents）
INSERT INTO subscription_plans (plan_code, name, price_cents, duration_days, is_active, sort_order)
VALUES ('month', '月卡', 2000, 30, 1, 1), ('year', '年卡', 19800, 365, 1, 2)
ON DUPLICATE KEY UPDATE id = id;

-- 存量家长回填 7 天试用（重复执行不重复插；新家长走注册钩子，不依赖此句）
-- 注意：不加 ON DUPLICATE KEY UPDATE —— 目标表同时是 SELECT 源（别名 fs）时，
-- ODKU 里任何裸列名都会报 1052 ambiguous（本机 MySQL 9.x 实测）；幂等由下面的
-- LEFT JOIN ... WHERE fs.id IS NULL 反连接保证，唯一键 uk_family_subscriptions_parent 兜底。
INSERT INTO family_subscriptions (parent_id, status, trial_ends_at, source)
SELECT p.id, 'trialing', DATE_ADD(NOW(3), INTERVAL 7 DAY), 'trial'
FROM parents p
LEFT JOIN family_subscriptions fs ON fs.parent_id = p.id
WHERE fs.id IS NULL;
