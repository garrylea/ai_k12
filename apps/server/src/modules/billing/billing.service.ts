import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { OrdersRepository, parseOrderSnapshot } from '../../database/repositories/orders.repo.js';
import type {
  OrderClaimStatus,
  OrderPaymentStatus,
  OrderPlanSnapshot,
  OrderRow,
} from '../../database/repositories/orders.repo.js';
import { BillingNoticesRepository } from '../../database/repositories/billing-notices.repo.js';
import { SubscriptionPlansRepository } from '../../database/repositories/subscription-plans.repo.js';
import { SubscriptionsService } from './subscriptions.service.js';
import { ORDER_PENDING_TTL_MINUTES } from './billing.config.js';
import type { CallbackPayload, ChannelHttpResponse, ChannelOrderResult, PayChannelAdapter } from './pay-channel.types.js';

/**
 * 适配器 DI token：三个适配器**故意没有** @Injectable()（构造参数是原语/env，
 * emitDecoratorMetadata 会把它标成 Object，Nest 按 token 找不到即启动失败——CLAUDE.md DI 坑）。
 * 模块里用 useFactory 显式构造（billing.module.ts），这里只声明 token 供注入与装配对齐。
 */
export const WECHAT_PAY_ADAPTER = 'WECHAT_PAY_ADAPTER';
export const ALIPAY_PAY_ADAPTER = 'ALIPAY_PAY_ADAPTER';
export const MOCK_PAY_ADAPTER = 'MOCK_PAY_ADAPTER';

export interface OrderView {
  orderNo: string;
  paymentStatus: 'pending' | 'paid' | 'cancelled' | 'expired';
  amountCents: number;
  planName: string;
  channel: string;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  /** 家长端支付弹层裁决三态（批④）：null = 未发起申诉。 */
  claimStatus: OrderClaimStatus | null;
  claimNote: string | null;
}

/** 订单详情（支付弹层用）：比列表多二维码/跳转入口两个字段。 */
export interface OrderDetailView extends OrderView {
  qrContent: string | null;
  redirectUrl: string | null;
}

export interface OrderListResult {
  items: OrderView[];
  total: number;
  page: number;
  pageSize: number;
}

/** admin 待裁决列表行（批④ Task 3）。 */
export interface ClaimView {
  orderNo: string;
  parentPhone: string;
  planName: string;
  amountCents: number;
  claimStatus: OrderClaimStatus;
  claimedAt: string | null;
  claimNote: string | null;
  paymentStatus: OrderPaymentStatus;
}

export interface ClaimListResult {
  items: ClaimView[];
  total: number;
  page: number;
  pageSize: number;
}

const ISO = (d: Date | null): string | null => (d != null ? d.toISOString() : null);

/** `ORD` + yyyyMMddHHmmss + 6 位随机数字（23 位，uk_orders_no VARCHAR(32) 内）。 */
export function buildOrderNo(now: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `ORD${ts}${pad(Math.floor(Math.random() * 1_000_000), 6)}`;
}

function isDupEntry(err: unknown): boolean {
  const e = err as { code?: string; errno?: number } | null;
  return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062;
}

/**
 * 订单状态机（批②核心，spec §5.2/§5.3）。
 *
 * - `pending → paid` 唯一入账路径是 {@link finalizePaidOrder}：单事务内
 *   `markPaidTx`（原子条件更新）+ `renewWithinTx`（家庭订阅顺延），同生共死；
 *   条件更新影响 0 行 = 并发已入账 → ROLLBACK 返回 'duplicate'，天然幂等。
 * - 回调 / confirm-paid / admin mark-paid 三个入口都汇入 finalize，互为幂等兜底。
 * - 错误码：2002 状态不允许 / 2003 渠道异常 / 2004 未确认支付 / 2005 套餐不存在。
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  /** 自动查单限频表（批④ Task 2）：orderNo -> 上次查单时刻；入账成功即删除。 */
  private channelCheckAt = new Map<string, number>();
  private static CHANNEL_CHECK_INTERVAL_MS = 10_000;

  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    @Inject(OrdersRepository) private readonly ordersRepo: OrdersRepository,
    @Inject(SubscriptionPlansRepository) private readonly plansRepo: SubscriptionPlansRepository,
    @Inject(SubscriptionsService) private readonly subscriptionsService: SubscriptionsService,
    @Inject(WECHAT_PAY_ADAPTER) private readonly wechatAdapter: PayChannelAdapter,
    @Inject(ALIPAY_PAY_ADAPTER) private readonly alipayAdapter: PayChannelAdapter,
    @Inject(MOCK_PAY_ADAPTER) private readonly mockAdapter: PayChannelAdapter,
    @Inject(BillingNoticesRepository) private readonly noticesRepo: BillingNoticesRepository,
  ) {}

  // ---------- 下单 ----------

  /**
   * 家长下单（spec §5.2 POST /api/billing/orders）。
   *
   * 防串单：同家长已有 pending 时——同套餐同渠道 → 复用返回（不新建行、不调渠道）；
   * 换套餐或换渠道 → 2002（先取消旧单或等 2h 超时）。渠道失败抛 2003，订单保留
   * pending（可取消重下，不自动删行）。
   */
  async createOrder(parentId: number, input: { planCode: string; channel: string }): Promise<OrderView> {
    const { planCode, channel } = input;
    if (!this.isChannelAllowed(channel)) {
      throw new BadRequestException({ code: 1001, message: '不支持的支付渠道' });
    }

    const plan = await this.plansRepo.findActiveByCode(planCode);
    if (!plan) {
      throw new NotFoundException({ code: 2005, message: '套餐不存在或已下架' });
    }

    // 下单入口惰性翻转：先清掉超时僵尸 pending，防止被复用或挡住重下（与读路径同一机制）
    await this.ordersRepo.expireStale();

    const pending = await this.ordersRepo.findPendingByParent(parentId);
    if (pending) {
      const pendingSnap = parseOrderSnapshot(pending.plan_snapshot);
      if (pendingSnap.planCode === planCode && pending.channel === channel) {
        return this.toView(pending); // 复用：不重复下单、不重复向渠道要码
      }
      throw new BadRequestException({
        code: 2002,
        message: '已有进行中的支付订单，请先取消原订单或等待 2 小时超时',
      });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ORDER_PENDING_TTL_MINUTES * 60_000);
    const snapshot: OrderPlanSnapshot = {
      planCode: plan.plan_code,
      name: plan.name,
      priceCents: plan.price_cents,
      durationDays: plan.duration_days,
    };

    // 撞 uk_orders_no 重试一次（同秒并发 + 随机段碰撞；再撞说明有别的异常，向外抛）
    let orderNo = '';
    let orderId = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const candidate = buildOrderNo(now);
      try {
        orderId = await this.ordersRepo.insertOrder({
          orderNo: candidate,
          parentId,
          planId: plan.id,
          planSnapshot: snapshot,
          amountCents: plan.price_cents,
          channel,
          expiresAt,
        });
        orderNo = candidate;
        break;
      } catch (err) {
        if (attempt === 1 && isDupEntry(err)) continue;
        throw err;
      }
    }

    // 线下转账（批④ Task 4）：无渠道适配器可走——订单 pending 即下单产物，
    // channel_trade_no/channel_qr_content 保持 NULL；入账只经 admin 裁决
    // （approveClaim / adminMarkPaid）。防串单复用与 2h 超时上方逻辑已同样适用。
    if (channel === 'manual') {
      const row = await this.ordersRepo.findByOrderNo(orderNo);
      return this.toView(row!); // 同一请求内刚写入，必存在
    }

    const adapter = this.resolveAdapter(channel);
    let result: ChannelOrderResult;
    try {
      result = await adapter.createOrder({ orderNo, amountCents: plan.price_cents, description: plan.name });
    } catch (err) {
      if (err instanceof HttpException) throw err; // 适配器自带 503/2003 语义，原样透传
      this.logger.error(`渠道下单失败 orderNo=${orderNo}: ${err}`);
      throw new HttpException({ code: 2003, message: '支付渠道异常' }, 503);
    }
    await this.ordersRepo.setChannelResult(orderId, result.tradeNo, result.qrContent);

    const row = await this.ordersRepo.findByOrderNo(orderNo);
    return this.toView(row!); // 同一请求内刚写入，必存在
  }

  // ---------- 查询 ----------

  async getOrder(parentId: number, orderNo: string): Promise<OrderDetailView> {
    await this.ordersRepo.expireStale(); // 读时惰性翻转
    const order = await this.requireOwnedOrder(parentId, orderNo);
    await this.maybeQueryChannel(order); // 扫码零点击到账：家长轮询详情时限频主动查渠道（await 完成再返回）
    return { ...this.toView(order), qrContent: order.channel_qr_content, redirectUrl: null };
  }

  async listOrders(parentId: number, page = 1, pageSize = 20): Promise<OrderListResult> {
    // 越界 400/1001 不钳制（仓规）
    if (!Number.isInteger(page) || page < 1) {
      throw new BadRequestException({ code: 1001, message: 'page 必须是正整数' });
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new BadRequestException({ code: 1001, message: 'pageSize 必须是 1..50 的整数' });
    }
    await this.ordersRepo.expireStale(); // 读时惰性翻转
    const { total, rows } = await this.ordersRepo.listByParent(parentId, page, pageSize);
    return { items: rows.map((r) => this.toView(r)), total, page, pageSize };
  }

  // ---------- 状态迁移（家长侧） ----------

  async cancel(parentId: number, orderNo: string): Promise<OrderView> {
    const order = await this.requireOwnedOrder(parentId, orderNo);
    if (order.payment_status !== 'pending') {
      throw new BadRequestException({ code: 2002, message: '订单状态不允许取消' });
    }
    const affected = await this.ordersRepo.cancelPending(order.id, new Date());
    if (affected === 0) {
      // 并发竞态：读时还是 pending，写前已被回调/查单终态化
      throw new BadRequestException({ code: 2002, message: '订单状态不允许取消' });
    }
    return { ...this.toView(order), paymentStatus: 'cancelled' };
  }

  /**
   * 「我已付款」兜底：家长点按钮后主动查渠道。已支付 → finalize；未支付 → 2004
   * 且**落 claim 转人工核实**（批④ Task 3：claim_status='pending_review'、claimed_at=now、
   * note ≤200 存 claim_note，重复点击刷新时间戳幂等）；渠道异常 → 2003（适配器自抛）。
   * note 超长 → 400/1001（不截断，家长侧输入本就限长）。
   * manual 线下转账单（批④ Task 4）：跳过渠道查单（无渠道可查），note 必填
   * （空/纯空白 → 400/1001「请填写转账备注」）→ 直接落 claim pending_review → 2004。
   * 返回值带 claimStatus（成功路径响应体透传；2004 错误体也带 claimStatus='pending_review'）。
   */
  async confirmPaid(
    parentId: number,
    orderNo: string,
    note?: string,
  ): Promise<{ result: 'paid' | 'duplicate'; claimStatus: OrderClaimStatus | null }> {
    if (note != null && note.length > 200) {
      throw new BadRequestException({ code: 1001, message: 'note 不能超过 200 字' });
    }
    await this.ordersRepo.expireStale(); // 读时惰性翻转
    const order = await this.requireOwnedOrder(parentId, orderNo);
    if (order.payment_status === 'paid') {
      return { result: 'duplicate', claimStatus: order.claim_status };
    }
    if (order.payment_status !== 'pending') {
      throw new BadRequestException({ code: 2002, message: '订单状态不允许该操作' });
    }

    // 线下转账（批④ Task 4）：无渠道可查——note 必填（空/纯空白 → 400/1001），
    // 直接落 claim 转人工核实（admin 裁决通过后入账）；重复点击刷新 claimed_at 幂等。
    if (order.channel === 'manual') {
      if (!note || note.trim().length === 0) {
        throw new BadRequestException({ code: 1001, message: '请填写转账备注' });
      }
      await this.ordersRepo.markClaim(order.id, 'pending_review', note, new Date());
      throw new BadRequestException({
        code: 2004,
        message: '渠道尚未确认，已转人工核实',
        claimStatus: 'pending_review',
      });
    }

    const adapter = this.resolveAdapter(order.channel);
    const q = await adapter.queryOrder(order.order_no);
    if (!q.paid) {
      // 渠道未确认：落 claim（转人工核实，admin 列表可见）。重复点击每次刷新 claimed_at，幂等
      await this.ordersRepo.markClaim(order.id, 'pending_review', note, new Date());
      throw new BadRequestException({
        code: 2004,
        message: '渠道尚未确认，已转人工核实',
        claimStatus: 'pending_review',
      });
    }
    if (q.amountCents != null && q.amountCents !== order.amount_cents) {
      this.logger.warn(
        `[billing] 查单金额不符：orderNo=${order.order_no} 渠道报 ${q.amountCents}，订单 ${order.amount_cents}，拒绝入账（人工介入）`,
      );
      throw new BadRequestException({ code: 2004, message: '渠道金额与订单不符，未确认支付' });
    }
    const result = await this.finalizePaidOrder(order, q.tradeNo ?? order.order_no);
    // finalize 的挂点已把 pending_review → approved；这里按入账结果报最终口径（不回读）
    const claimStatus: OrderClaimStatus | null =
      result === 'paid' && order.claim_status === 'pending_review' ? 'approved' : order.claim_status;
    return { result, claimStatus };
  }

  // ---------- 状态迁移（回调 / admin） ----------

  /**
   * 渠道异步回调（spec §5.2 POST /api/billing/callback/{channel}，免 JWT）。
   * 永远给渠道一个明确应答（success/failure），验签/找单/串单/金额四道闸全过才入账。
   * 渠道解析走 {@link resolveCallbackAdapter}：BILLING_USE_MOCK=1 时 wechat/alipay
   * 回调也强制真实适配器验签（裸 JSON 零验签不可入账）。
   */
  async handleCallback(
    channel: string,
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): Promise<ChannelHttpResponse> {
    let adapter: PayChannelAdapter;
    try {
      adapter = this.resolveCallbackAdapter(channel);
    } catch {
      // 未知渠道：没有适配器就没有它的应答格式，返回 500 文本让渠道侧重试/告警
      return { httpStatus: 500, body: 'unknown channel', contentType: 'text/plain' };
    }

    let payload: CallbackPayload;
    try {
      payload = await adapter.verifyCallback(headers, rawBody);
    } catch (err) {
      this.logger.warn(`[billing] 回调验签/解析失败 channel=${channel}: ${err}`);
      return adapter.failureResponse('验签失败');
    }

    const order = await this.ordersRepo.findByOrderNo(payload.orderNo);
    if (!order) return adapter.failureResponse('订单不存在');
    if (order.channel !== channel) return adapter.failureResponse('订单渠道不符');

    if (payload.amountCents !== order.amount_cents) {
      // 金额不符：不入账。本批无 alert 表，logger.warn 即 admin 侧留痕，人工对账介入
      this.logger.warn(
        `[billing] 回调金额不符：orderNo=${order.order_no} 渠道报 ${payload.amountCents}，订单 ${order.amount_cents}，拒绝入账（人工介入）`,
      );
      return adapter.failureResponse('金额不符');
    }

    if (!payload.paid) return adapter.successResponse(); // 非支付成功通知：确认收到即可
    if (order.payment_status === 'paid') return adapter.successResponse(); // 重复通知，幂等
    if (order.payment_status === 'cancelled') {
      // 用户裁决（2026-09-30 终态单回调方案 A）：cancelled 维持拒绝；本仓无 admin 通知表，
      // error 级留痕即本期的「显式预警」，需人工处理（钱可能真付了但单已取消）
      this.logger.error(
        `[BILLING] 已取消订单收到真支付回调，需人工处理：orderNo=${order.order_no}, tradeNo=${payload.tradeNo}, amount=${payload.amountCents}`,
      );
      return adapter.failureResponse('订单状态不允许');
    }
    // pending 正常入账；expired 放行（用户裁决：验签+金额已全过的 paid 回调照常入账，
    // 订阅顺延——家长只是等过了 2h 超时才回调到，钱是真的就不该让订单白过期）

    // finalize 抛错也必须给渠道明确应答（口径：handleCallback 永不向外抛）；logger.error 留痕
    try {
      await this.finalizePaidOrder(order, payload.tradeNo);
    } catch (err) {
      this.logger.error(`[billing] 回调入账失败：orderNo=${order.order_no}: ${err}`);
      return adapter.failureResponse('入账失败');
    }
    return adapter.successResponse(); // 'paid' 与并发 'duplicate' 都算成功应答
  }

  /**
   * admin 人工兜底（线下收款）：channel 不变，tradeNo 用 `manual-{orderNo}` 标记来源。
   * 审计：操作人 adminId / 单号 / 时间 / 结果（paid|duplicate）一律 logger.log 留痕
   * （本仓无 admin 操作审计表，日志即留痕；adminId 从 JWT sub 透传，缺省记 unknown）。
   */
  async adminMarkPaid(orderNo: string, adminId?: number): Promise<'paid' | 'duplicate'> {
    const order = await this.ordersRepo.findByOrderNo(orderNo);
    if (!order) throw new NotFoundException({ code: 1005, message: '订单不存在' });
    if (order.payment_status === 'paid') {
      this.logger.log(
        `[BILLING] admin mark-paid：adminId=${adminId ?? 'unknown'} orderNo=${orderNo} result=duplicate time=${new Date().toISOString()}`,
      );
      return 'duplicate'; // 幂等成功
    }
    if (order.payment_status !== 'pending' && order.payment_status !== 'expired') {
      // expired 放行（2026-09-30 用户裁决方案 A：管理员是裁决人，过期单收到真款应可手工入账）；
      // cancelled 及其他终态仍拒。与 markPaidTx 谓词、approveClaim 内联口径对齐。
      throw new BadRequestException({ code: 2002, message: '订单状态不允许该操作' });
    }
    const result = await this.finalizePaidOrder(order, `manual-${order.order_no}`);
    this.logger.log(
      `[BILLING] admin mark-paid：adminId=${adminId ?? 'unknown'} orderNo=${orderNo} result=${result} time=${new Date().toISOString()}`,
    );
    return result;
  }

  // ---------- 裁决链路（claim 状态机，批④ Task 3） ----------

  /**
   * admin 通过裁决：复用 {@link adminMarkPaid} 的入账语义（finalize + `manual-` tradeNo + 审计留痕），
   * 但状态闸门放宽到 expired（markPaidTx 本就放行 pending|expired——家长只是超时后才被确认付款，
   * 钱是真的就不该白过期）；cancelled 仍 2002。claim 非 pending_review → 2002。
   * claim 置 approved 由 finalize 内挂点完成；「已 paid 但 claim 仍 pending_review」（挂点当时失败）
   * 在这里补一条幂等 UPDATE。
   */
  async approveClaim(orderNo: string, adminId?: number): Promise<'paid' | 'duplicate'> {
    const order = await this.ordersRepo.findByOrderNo(orderNo);
    if (!order) throw new NotFoundException({ code: 1005, message: '订单不存在' });
    if (order.claim_status !== 'pending_review') {
      throw new BadRequestException({ code: 2002, message: '该订单不在待人工核验状态' });
    }
    if (order.payment_status === 'cancelled') {
      throw new BadRequestException({ code: 2002, message: '订单状态不允许该操作' });
    }
    let result: 'paid' | 'duplicate';
    if (order.payment_status === 'paid') {
      result = 'duplicate'; // 入账已发生过，不重复续期，只补 claim 闭环
    } else {
      result = await this.finalizePaidOrder(order, `manual-${order.order_no}`);
    }
    if (result === 'duplicate') {
      try {
        await this.ordersRepo.markClaim(order.id, 'approved');
        // 通知挂点：markClaim 成功（迁移真实发生）才通知；paid 路径的通知由 finalize 挂点覆盖，勿重复插
        await this.notifyClaimResult(order, 'claim_approved', null);
      } catch (err) {
        this.logger.warn(`[billing] claim 置 approved 失败 orderNo=${orderNo}: ${err}`);
      }
    }
    this.logger.log(
      `[BILLING] admin approve-claim：adminId=${adminId ?? 'unknown'} orderNo=${orderNo} result=${result} time=${new Date().toISOString()}`,
    );
    return result;
  }

  /**
   * admin 驳回裁决：claim 必须为 pending_review（否则 2002）→ 'rejected'。
   * reason 追加到 claim_note 尾部（`原note；驳回：reason`），截断 200（列宽 VARCHAR(200)）。
   */
  async rejectClaim(orderNo: string, adminId?: number, reason?: string): Promise<void> {
    const order = await this.ordersRepo.findByOrderNo(orderNo);
    if (!order) throw new NotFoundException({ code: 1005, message: '订单不存在' });
    if (order.claim_status !== 'pending_review') {
      throw new BadRequestException({ code: 2002, message: '该订单不在待人工核验状态' });
    }
    const parts = [order.claim_note ?? '', reason ? `驳回：${reason}` : '驳回'].filter((s) => s.length > 0);
    const note = parts.join('；').slice(0, 200);
    await this.ordersRepo.markClaim(order.id, 'rejected', note);
    // 通知挂点：驳回迁移真实发生才通知家长（reason 用入参原文，非拼接 claim_note）
    await this.notifyClaimResult(order, 'claim_rejected', reason ?? null);
    this.logger.log(
      `[BILLING] admin reject-claim：adminId=${adminId ?? 'unknown'} orderNo=${orderNo} note=${note} time=${new Date().toISOString()}`,
    );
  }

  /**
   * admin 待裁决列表：status 缺省 pending_review、非法值 400/1001；分页校验同 listOrders
   * （越界 400/1001 不钳制，仓规）。
   */
  async listClaims(status?: string, page = 1, pageSize = 20): Promise<ClaimListResult> {
    if (!Number.isInteger(page) || page < 1) {
      throw new BadRequestException({ code: 1001, message: 'page 必须是正整数' });
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
      throw new BadRequestException({ code: 1001, message: 'pageSize 必须是 1..50 的整数' });
    }
    const st = status ?? 'pending_review';
    if (st !== 'pending_review' && st !== 'approved' && st !== 'rejected') {
      throw new BadRequestException({ code: 1001, message: 'status 必须是 pending_review/approved/rejected' });
    }
    const { total, rows } = await this.ordersRepo.findClaims(st, page, pageSize);
    return {
      items: rows.map((r) => ({
        orderNo: r.order_no,
        parentPhone: r.parent_phone,
        planName: parseOrderSnapshot(r.plan_snapshot).name,
        amountCents: r.amount_cents,
        claimStatus: r.claim_status!,
        claimedAt: ISO(r.claimed_at),
        claimNote: r.claim_note,
        paymentStatus: r.payment_status,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** 裁决结果通知（spec §2.1）：只在实际迁移发生处调用；失败 warn 不阻断。 */
  private async notifyClaimResult(order: OrderRow, type: 'claim_approved' | 'claim_rejected', reason: string | null): Promise<void> {
    try {
      await this.noticesRepo.insert({ parentId: order.parent_id, type, orderNo: order.order_no, reason });
    } catch (err) {
      this.logger.warn(`[billing] 裁决通知落库失败（不阻断裁决）orderNo=${order.order_no} type=${type}: ${err}`);
    }
  }

  // ---------- 核心：入账事务 ----------

  /**
   * 单事务入账（brief Step 2 骨架）：`markPaidTx` 条件更新（影响 0 = 并发已入账）
   * → ROLLBACK 返回 'duplicate'；否则同事务续期家庭订阅后 COMMIT。
   * 订单与订阅同生共死，任何一步失败整体回滚。
   */
  async finalizePaidOrder(order: OrderRow, tradeNo: string, now: Date = new Date()): Promise<'paid' | 'duplicate'> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const affected = await this.ordersRepo.markPaidTx(conn, order.id, tradeNo, now);
      if (affected === 0) {
        await conn.rollback();
        return 'duplicate';
      }
      const snap = parseOrderSnapshot(order.plan_snapshot);
      await this.subscriptionsService.renewWithinTx(conn, order.parent_id, snap.planCode, snap.durationDays);
      await conn.commit();
      // claim 闭环挂点（批④ Task 3）：放事务**外**——claim 置 approved 失败只 warn，
      // 绝不回滚入账（admin 列表仍可见 pending_review，可走 approveClaim 补挂）
      if (order.claim_status === 'pending_review') {
        try {
          await this.ordersRepo.markClaim(order.id, 'approved');
          // 通知挂点：闭环迁移真实发生才通知（approveClaim paid 路径经此处覆盖）
          await this.notifyClaimResult(order, 'claim_approved', null);
        } catch (err) {
          this.logger.warn(`[billing] claim 置 approved 失败（入账已完成不回滚）orderNo=${order.order_no}: ${err}`);
        }
      }
      return 'paid';
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // ---------- 内部 ----------

  /**
   * 渠道选用：'manual'（线下转账，批④ Task 4）永远放行（但 createOrder/confirmPaid
   * 对其不走适配器）；'mock' 仅在 `NODE_ENV==='test'` 或 `BILLING_USE_MOCK==='1'` 时放行
   * （且只解析到 MockPayAdapter）；真实下单只允许 wechat/alipay。
   */
  private isChannelAllowed(channel: string): boolean {
    if (channel === 'wechat' || channel === 'alipay') return true;
    // 线下转账（批④ Task 4，当前付费主路径）：合法渠道但**不走适配器**（见 createOrder / confirmPaid）
    if (channel === 'manual') return true;
    if (channel === 'mock') {
      return process.env.NODE_ENV === 'test' || process.env.BILLING_USE_MOCK === '1';
    }
    return false;
  }

  /**
   * 回调专用渠道解析：**wechat/alipay 永远解析到真实适配器**，即使 `BILLING_USE_MOCK=1`。
   * mock 映射只服务于下单/查单（演示模式 UI 渠道 radio 发不出 channel='mock'）；
   * 若回调也映射到 Mock，则裸 JSON 零验签即可入账（免验签入账洞）。mock 模式的
   * 入账既定路径是 confirm-paid，不受影响；channel='mock' 的回调仅测试环境放行
   * （HTTP 层 controller 已把非 wechat/alipay 404 拦掉，这里只为单测直调兜底）。
   */
  private resolveCallbackAdapter(channel: string): PayChannelAdapter {
    switch (channel) {
      case 'wechat':
        return this.wechatAdapter;
      case 'alipay':
        return this.alipayAdapter;
      case 'mock':
        if (process.env.NODE_ENV === 'test' || process.env.BILLING_USE_MOCK === '1') {
          return this.mockAdapter;
        }
        break;
    }
    throw new HttpException({ code: 2003, message: `未知支付渠道：${channel}` }, 503);
  }

  /**
   * 订单详情读路径的自动查单（批④ Task 2）：家长支付弹层约 3s 轮询 getOrder，
   * 此处限频 10s 主动查真实渠道——扫码后零点击到账，不再依赖家长点「我已付款」。
   *
   * 渠道解析走 {@link resolveCallbackAdapter}（callback 口径）：BILLING_USE_MOCK=1 时
   * wechat/alipay 也不得被 mock 截胡（mock 渠道演示的入账只走 confirm-paid）。
   * 状态放行 pending + expired：markPaidTx 已放行 expired（2026-09-30 方案 A——钱是真的
   * 不该让订单白过期），cancelled/paid 直接跳过。
   * 金额不符拒绝入账（同 confirmPaid/回调口径，warn 留痕人工介入）；
   * 任何渠道异常只 warn 吞掉，绝不影响家长读路径（查单超时由适配器自身 10s AbortSignal 兜底）。
   */
  private async maybeQueryChannel(order: OrderRow): Promise<void> {
    if (order.payment_status !== 'pending' && order.payment_status !== 'expired') return;
    if (order.channel !== 'wechat' && order.channel !== 'alipay') return;
    const now = Date.now();
    const last = this.channelCheckAt.get(order.order_no) ?? 0;
    if (now - last < BillingService.CHANNEL_CHECK_INTERVAL_MS) return;
    this.channelCheckAt.set(order.order_no, now);
    try {
      const adapter = this.resolveCallbackAdapter(order.channel); // 真实适配器，不走 BILLING_USE_MOCK 的 mock 映射
      const r = await adapter.queryOrder(order.order_no);
      if (r.paid) {
        if (r.amountCents != null && r.amountCents !== order.amount_cents) {
          this.logger.warn(
            `[BILLING] 自动查单金额不符：orderNo=${order.order_no} 渠道报 ${r.amountCents}，订单 ${order.amount_cents}，拒绝入账（人工介入）`,
          );
          return;
        }
        await this.finalizePaidOrder(order, r.tradeNo ?? `query-${order.order_no}`, new Date());
        this.channelCheckAt.delete(order.order_no);
      }
    } catch (err) {
      this.logger.warn(`[BILLING] 自动查单失败（不影响家长读路径）: ${order.order_no} ${err}`);
    }
  }

  private resolveAdapter(channel: string): PayChannelAdapter {
    // BILLING_USE_MOCK=1：wechat/alipay 也解析到 Mock —— UI 渠道 radio 只有微信/支付宝、
    // 发不出 channel='mock'，不映射则本地/演示环境 UI 下单必 503「支付渠道未配置」。
    if (process.env.BILLING_USE_MOCK === '1') {
      return this.mockAdapter;
    }
    switch (channel) {
      case 'wechat':
        return this.wechatAdapter;
      case 'alipay':
        return this.alipayAdapter;
      case 'mock':
        return this.mockAdapter;
      default:
        throw new HttpException({ code: 2003, message: `未知支付渠道：${channel}` }, 503);
    }
  }

  /** 归属校验：不存在与不属于同一应答（不泄露订单存在性），403/1005 与 RolesGuard 同码。 */
  private async requireOwnedOrder(parentId: number, orderNo: string): Promise<OrderRow> {
    const order = await this.ordersRepo.findByOrderNo(orderNo);
    if (!order || order.parent_id !== parentId) {
      throw new ForbiddenException({ code: 1005, message: '无权访问该订单' });
    }
    return order;
  }

  private toView(row: OrderRow): OrderView {
    const snap = parseOrderSnapshot(row.plan_snapshot);
    return {
      orderNo: row.order_no,
      paymentStatus: row.payment_status,
      amountCents: row.amount_cents,
      planName: snap.name,
      channel: row.channel,
      createdAt: ISO(row.created_at)!,
      expiresAt: ISO(row.expires_at)!,
      paidAt: ISO(row.paid_at),
      claimStatus: row.claim_status ?? null,
      claimNote: row.claim_note ?? null,
    };
  }
}
