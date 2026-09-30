/** 试用期天数（终审必修 3）：env 非法（空串/负数/非数字）一律回落 7 —— `Number('')===0` 会让全员注册即锁死。 */
export function resolveTrialDays(raw: string | undefined): number {
  const n = Number(raw ?? 7);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export const TRIAL_DAYS = resolveTrialDays(process.env.SUBSCRIPTION_TRIAL_DAYS);
export const ORDER_PENDING_TTL_MINUTES = 120;
export const SUBSCRIPTION_EXPIRING_SOON_DAYS = 7;
