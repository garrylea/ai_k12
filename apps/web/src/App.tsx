import { AppRouter } from '@/routes';
import { ToastContainer } from '@/components/base';
import { PointsToast } from '@/components/business/PointsToast';

/**
 * `<PointsToast />` 必须挂在根上（`RouterProvider` 之内、任何 Layout 之外）：
 * 训练轨的答题页（专项 / 背单词 / 语文 / 考试）都是全屏页、不在任何 Layout 下，
 * 挂进某个外壳那些页面永远看不到发分反馈。
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