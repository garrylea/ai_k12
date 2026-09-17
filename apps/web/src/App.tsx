import { AppRouter } from '@/routes';
import { ToastContainer } from '@/components/base';
import { PointsToast } from '@/components/business/PointsToast';

/**
 * `<PointsToast />` 必须挂在这里而不是 `StudentLayout`：训练轨的答题页
 * （专项 / 背单词 / 语文 / 考试）都是全屏页、不在 `StudentLayout` 下，
 * 挂在那里那些页面永远看不到发分反馈。
 */
export default function App() {
  return (
    <>
      <AppRouter />
      <ToastContainer />
      <PointsToast />
    </>
  );
}