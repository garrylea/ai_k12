import { AppRouter } from '@/routes';
import { ToastContainer } from '@/components/base';

export default function App() {
  return (
    <>
      <AppRouter />
      <ToastContainer />
    </>
  );
}