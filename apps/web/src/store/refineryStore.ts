import { create } from 'zustand';

interface RefineryState {
  taskId: number | null;
  status: 'pending' | 'processing' | 'completed' | 'failed' | null;
  markdown: string;
  structured: unknown;
  errorMessage: string;
  setTask: (taskId: number) => void;
  setStatus: (status: RefineryState['status']) => void;
  setResult: (markdown: string, structured: unknown) => void;
  setError: (msg: string) => void;
  reset: () => void;
}

export const useRefineryStore = create<RefineryState>((set) => ({
  taskId: null,
  status: null,
  markdown: '',
  structured: null,
  errorMessage: '',
  setTask: (taskId) => set({ taskId, status: 'pending' }),
  setStatus: (status) => set({ status }),
  setResult: (markdown, structured) => set({ markdown, structured, status: 'completed' }),
  setError: (errorMessage) => set({ errorMessage, status: 'failed' }),
  reset: () => set({ taskId: null, status: null, markdown: '', structured: null, errorMessage: '' }),
}));
