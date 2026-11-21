import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useMaterialDoc, preloadMaterialDoc } from './useMaterialDoc';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Probe({ url }: { url: string }) {
  const { text, status } = useMaterialDoc(url);
  return <span data-testid="probe">{status}:{text}</span>;
}

describe('useMaterialDoc', () => {
  it('loads and caches a doc', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '## 醉翁亭记' });
    vi.stubGlobal('fetch', fetchMock);
    render(<Probe url="materials/chinese/a/content.md" />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready:## 醉翁亭记'));
    await preloadMaterialDoc('materials/chinese/a/content.md');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exposes error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    render(<Probe url="materials/chinese/missing/content.md" />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('error:'));
  });

  it('clears the previous doc when the url changes', async () => {
    const pending = new Promise(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => '## A' })
      .mockImplementationOnce(() => pending);
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<Probe url="materials/chinese/u1/content.md" />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready:## A'));
    rerender(<Probe url="materials/chinese/u2/content.md" />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('loading:'));
  });
});
