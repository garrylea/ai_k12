export type SubscriptionStatus = 'trialing' | 'active' | 'expired';

export interface SubscriptionTimes {
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

export function effectiveStatus(now: Date, t: SubscriptionTimes): SubscriptionStatus {
  if (t.currentPeriodEnd != null && now.getTime() <= t.currentPeriodEnd.getTime()) return 'active';
  if (t.trialEndsAt != null && now.getTime() <= t.trialEndsAt.getTime()) return 'trialing';
  return 'expired';
}

export function daysRemaining(now: Date, end: Date): number {
  const diff = end.getTime() - now.getTime();
  if (diff <= 0) return 0;
  return Math.ceil(diff / 86_400_000);
}
