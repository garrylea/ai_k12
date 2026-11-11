-- 做题入口识题（MinerU）配置从 .env 迁到数据库：单行配置表 + 一行默认值。
-- 幂等：表已存在跳过；默认行已存在时不覆盖（ON DUPLICATE KEY UPDATE id = id）。
-- token 不在此播种：空 = 回落 .env 的 MINERU_TOKEN；后台保存后会以加密形式写入。
CREATE TABLE IF NOT EXISTS mineru_config (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1 PRIMARY KEY,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  bin VARCHAR(255) NOT NULL DEFAULT 'mineru-open-api',
  token VARCHAR(500) NOT NULL DEFAULT '',
  timeout_ms INT NOT NULL DEFAULT 90000,
  concurrency TINYINT UNSIGNED NOT NULL DEFAULT 2,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO mineru_config (id) VALUES (1)
  ON DUPLICATE KEY UPDATE id = id;
