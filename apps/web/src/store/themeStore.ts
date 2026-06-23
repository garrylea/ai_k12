import { create } from 'zustand';
import { ThemeMode } from '@/types';

interface ThemeState {
  mode: ThemeMode;
  motionEnabled: boolean;
  setMode: (mode: ThemeMode) => void;
  toggleMotion: () => void;
  autoToggleNightMode: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: 'student-day',
  motionEnabled: true,

  setMode: (mode) => set({ mode }),
  toggleMotion: () => set({ motionEnabled: !get().motionEnabled }),

  autoToggleNightMode: () => {
    const hour = new Date().getHours();
    const isNight = hour >= 18 || hour < 6;
    const current = get().mode;
    if (current !== 'parent') {
      set({ mode: isNight ? 'student-night' : 'student-day' });
    }
  },
}));
