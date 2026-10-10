-- 2026-10-10 单点登录互踢：每账号一行，token_seq = 当前有效会话序号（登录 +1）。
-- 旧 token 携带的 seq ≠ 当前行值 → AuthMiddleware 401/1013。spec: 2026-10-10-single-session-login-design.md
CREATE TABLE IF NOT EXISTS auth_sessions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role ENUM('admin','parent','student') NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  token_seq INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_role_user (role, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
