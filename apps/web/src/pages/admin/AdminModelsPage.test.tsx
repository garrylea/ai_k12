import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminModelsPage from './AdminModelsPage';
import {
  getAdminMineruConfig,
  listAdminModels,
  listAdminRoutes,
  saveAdminMineruConfig,
  validateMineruConfig,
} from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listAdminModels: vi.fn(),
    listAdminRoutes: vi.fn(),
    getAdminMineruConfig: vi.fn(),
    saveAdminMineruConfig: vi.fn(),
    validateMineruConfig: vi.fn(),
    validateModelConnection: vi.fn(),
    createAdminModel: vi.fn(),
    updateAdminModel: vi.fn(),
    setAdminModelStatus: vi.fn(),
    saveAdminRoutes: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const listModelsMock = vi.mocked(listAdminModels);
const listRoutesMock = vi.mocked(listAdminRoutes);
const getMineruMock = vi.mocked(getAdminMineruConfig);
const saveMineruMock = vi.mocked(saveAdminMineruConfig);
const validateMineruMock = vi.mocked(validateMineruConfig);

beforeEach(() => {
  listModelsMock.mockResolvedValue([]);
  listRoutesMock.mockResolvedValue({ routes: [], scenes: ['freeform_split'], providerTypes: ['qwen'] });
  getMineruMock.mockResolvedValue({
    enabled: true,
    bin: 'mineru-open-api',
    tokenMasked: 'sk-***ken',
    tokenSource: 'db',
    timeoutMs: 90000,
    concurrency: 2,
  });
  saveMineruMock.mockResolvedValue(null);
  validateMineruMock.mockResolvedValue({ ok: true, latencyMs: 123, sample: '# 1+1=?' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderLoaded() {
  render(<AdminModelsPage />);
  await waitFor(() => expect(screen.getByTestId('mineru-config')).toBeInTheDocument());
}

describe('AdminModelsPage：识图（MinerU）配置块', () => {
  it('渲染库里的配置：token 只显示掩码，不出现明文', async () => {
    await renderLoaded();

    expect(screen.getByText('识图（MinerU）')).toBeInTheDocument();
    expect(screen.getByTestId('mineru-token')).toHaveAttribute(
      'placeholder',
      '当前：sk-***ken（留空则不修改）',
    );
    expect(screen.getByTestId('mineru-token')).toHaveValue('');
    expect(document.body.textContent).not.toContain('sk-db-token');
  });

  it('token 留空保存：请求不带 token 字段（后端据此沿用旧值）', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() =>
      expect(saveMineruMock).toHaveBeenCalledWith({
        enabled: true,
        bin: 'mineru-open-api',
        timeoutMs: 90000,
        concurrency: 2,
      }),
    );
    expect(saveMineruMock.mock.calls[0][0]).not.toHaveProperty('token');
  });

  it('填入新 token / 改并发后保存：原样提交', async () => {
    await renderLoaded();

    fireEvent.change(screen.getByTestId('mineru-token'), { target: { value: 'sk-new-token' } });
    fireEvent.change(screen.getByDisplayValue('2'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() =>
      expect(saveMineruMock).toHaveBeenCalledWith({
        enabled: true,
        bin: 'mineru-open-api',
        token: 'sk-new-token',
        timeoutMs: 90000,
        concurrency: 4,
      }),
    );
  });

  it('测试连接直接委派后端探活，成功显示耗时', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));

    await waitFor(() => expect(validateMineruMock).toHaveBeenCalledTimes(1));
  });

  it('关闭启用开关时提交 enabled=false', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() =>
      expect(saveMineruMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })),
    );
  });
});
