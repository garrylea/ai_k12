import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnalyticsDevicesPage from './AnalyticsDevicesPage';
import { getAdminDevices, type DevicesData } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getAdminDevices: vi.fn() };
});

const getDevicesMock = vi.mocked(getAdminDevices);

afterEach(() => cleanup());

const DATA: DevicesData = {
  distributions: {
    platformClass: [
      { key: 'ipad', students: 5, seconds: 6000, sessions: 9, accuracy: 0.6 },
      { key: 'mac', students: 2, seconds: 1200, sessions: 3, accuracy: null },
    ],
    screenClass: [],
    inputType: [],
    appShell: [],
    browser: [],
  },
  multiDevice: [{ count: 2, students: 3 }],
  switches: { count: 7, students: 4 },
};

describe('AnalyticsDevicesPage', () => {
  it('渲染平台分布表（中文设备名）+ 多设备分档 + 切换计数', async () => {
    getDevicesMock.mockResolvedValue(DATA);

    render(
      <MemoryRouter>
        <AnalyticsDevicesPage />
      </MemoryRouter>,
    );

    // platformClass 默认维度：key → 中文映射、时长/正确率格式化、null → '—'
    const ipad = await screen.findByTestId('device-row-ipad');
    expect(ipad.textContent).toContain('iPad');
    expect(ipad.textContent).toContain('1 小时 40 分');
    expect(ipad.textContent).toContain('60%');
    const mac = screen.getByTestId('device-row-mac');
    expect(mac.textContent).toContain('Mac');
    expect(mac.textContent).toContain('—');

    expect(screen.getByTestId('multi-device-row-2').textContent).toContain('3');
    expect(screen.getByTestId('switches-line').textContent).toContain('设备切换 7 次');
    expect(screen.getByTestId('switches-line').textContent).toContain('4 人');
  });
});
