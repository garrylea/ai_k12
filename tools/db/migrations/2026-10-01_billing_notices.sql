-- 日期：2026-10-01 主旨：订阅收费批④补丁 —— 新表 billing_notices（裁决结果通知）
-- 设计：.superpowers/sdd/2026-10-01-billing-claim-notification/task-1-brief.md
--
-- 做什么：
--   新表 billing_notices：管理端 approve/reject/自动闭环各落一行未读通知，
--   家长 ack 后 is_read=1。家长端「我的通知」据此展示裁决结果。
--
-- 幂等：新表 CREATE TABLE IF NOT EXISTS，重复执行无副作用。
-- 回滚：
--   DROP TABLE billing_notices;

-- 订阅裁决结果通知（批④补丁）：approve/reject/自动闭环各落一行未读，家长 ack 后 is_read=1。
-- 无 (order_no,type) 唯一键：同单「驳回→重新主张→通过」两条通知均为有效事件，防重靠只在状态迁移时写入。
CREATE TABLE IF NOT EXISTS billing_notices (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  parent_id  BIGINT      NOT NULL COMMENT '家长 id（通知归属）',
  type       ENUM('claim_approved','claim_rejected') NOT NULL COMMENT '裁决结果',
  order_no   VARCHAR(64)  NOT NULL COMMENT '关联订单号',
  reason     VARCHAR(200) NULL COMMENT '驳回原因；approve 为 NULL',
  is_read    TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '0=未读；ack 后置 1',
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_parent_unread (parent_id, is_read, id),
  CONSTRAINT fk_billing_notices_parent FOREIGN KEY (parent_id) REFERENCES parents (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='订阅裁决结果通知（批④补丁）';
