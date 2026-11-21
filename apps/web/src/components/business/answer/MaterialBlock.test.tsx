import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MaterialBlock } from './MaterialBlock';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('MaterialBlock', () => {
  it('renders doc then in-question material', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '## 醉翁亭记' }));
    render(<MaterialBlock url="materials/chinese/a/content.md" text="注：①罪废" testId="m" />);
    await waitFor(() => expect(screen.getByTestId('m').textContent).toContain('醉翁亭记'));
    const text = screen.getByTestId('m').textContent ?? '';
    expect(text.indexOf('醉翁亭记')).toBeLessThan(text.indexOf('注：①罪废'));
  });

  it('renders only text when url is absent', () => {
    render(<MaterialBlock text="题中素材" testId="m" />);
    expect(screen.getByTestId('m').textContent).toContain('题中素材');
  });

  it('shows retry alongside in-question text when the doc fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    render(<MaterialBlock url="materials/chinese/missing2/content.md" text="注：①罪废" testId="m" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '材料加载失败，点击重试' })).toBeTruthy(),
    );
    expect(screen.getByTestId('m').textContent).toContain('注：①罪废');
  });
});
