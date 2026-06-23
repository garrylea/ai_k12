import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

let toastId = 0;
let globalAddToast: ((type: ToastType, message: string) => void) | null = null;

export function toast(type: ToastType, message: string) {
  globalAddToast?.(type, message);
}

const typeStyles: Record<ToastType, string> = {
  success: 'bg-[var(--success)] text-white',
  error: 'bg-[var(--error)] text-white',
  info: 'bg-[var(--info)] text-white',
  warning: 'bg-[var(--warning)] text-white',
};

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    globalAddToast = (type, message) => {
      const id = ++toastId;
      setToasts((prev) => [...prev, { id, type, message }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3000);
    };
    return () => { globalAddToast = null; };
  }, []);

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            className={clsx(
              'px-5 py-3 rounded-[var(--radius-button)] shadow-[var(--shadow-elevated)]',
              'text-sm font-medium',
              typeStyles[t.type],
            )}
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
          >
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}