import { create } from 'zustand';
import { listBillingClaims } from '@/services/api';

interface AdminBillingBadgeState {
  /** null = 从未成功拉取（不渲染角标）；失败静默保留旧值。 */
  pendingCount: number | null;
  setPendingCount: (n: number | null) => void;
  refresh: () => Promise<void>;
}

/** 管理端「订阅裁决」红点（批④补丁 spec §4）：AdminNav 读、AdminBillingPage 裁决后主动 refresh。 */
export const useAdminBillingBadgeStore = create<AdminBillingBadgeState>((set) => ({
  pendingCount: null,
  setPendingCount: (n) => set({ pendingCount: n }),
  refresh: async () => {
    try {
      const res = await listBillingClaims('pending_review', 1, 1);
      set({ pendingCount: res.total });
    } catch {
      /* 失败静默：角标永不阻断管理端导航 */
    }
  },
}));
