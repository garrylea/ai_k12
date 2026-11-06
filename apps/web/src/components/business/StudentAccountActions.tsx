import { LogoutButton } from '@/components/base';
import { getAuthItem } from '@/services/authStorage';
import { UserBadge } from './UserBadge';

/**
 * 学生端右上角统一账号区：用户状态药丸（段位入口）+ 独立退出按钮。
 *
 * 不另写控件——内部就是既有的 `UserBadge` / `LogoutButton`，这里只负责取一次
 * 用户名、固定两者间距，避免每个页面各写一遍 `getAuthItem('username')` 和同样的
 * 布局。形态与入口选择页 `/student/entry` 顶栏完全一致。
 */
export function StudentAccountActions({ onLogout }: { onLogout?: () => void }) {
  const username = getAuthItem('username') ?? '同学';

  return (
    <div className="flex items-center gap-2">
      <UserBadge username={username} />
      <LogoutButton onLogout={onLogout} />
    </div>
  );
}
