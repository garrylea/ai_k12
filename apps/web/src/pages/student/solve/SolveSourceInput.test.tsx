import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SolveSourceInput } from './SolveSourceInput';
import { uploadFile } from '@/services/api';
import { ensureJpeg } from '@/utils/image-convert';

/**
 * 状态 A · 录入（spec §3.2 / §8.3）。
 *
 * 契约要点：
 * 1. HEIC 先在客户端转 JPEG 再上传，`uploadFile` 的 source 必须是 `freeform`；
 * 2. 最多 6 张（第 7 张丢弃并提示），每张 ≤5MB、仅图片；
 * 3. 文字可选；纯文字提交时 `attachments` / `imageUrls` 都是空数组；
 * 4. 顺序 = 选择顺序，删中间一张后后续序号前移、提交仍按当前顺序；
 * 5. 所有图片 ready 且（有文字 或 ≥1 图）才允许「开始识题」。
 */

vi.mock('@/utils/image-convert', () => ({
  ensureJpeg: vi.fn(
    async (f: File) => new File([f], f.name.replace(/\.heic$/i, '.jpg'), { type: 'image/jpeg' }),
  ),
}));

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, uploadFile: vi.fn() };
});

const uploadFileMock = vi.mocked(uploadFile);
const ensureJpegMock = vi.mocked(ensureJpeg);

// jsdom 没有实现 `URL.createObjectURL`，预览缩略图会直接抛 TypeError。
const originalCreateObjectURL = URL.createObjectURL;

beforeEach(() => {
  vi.clearAllMocks();
  uploadFileMock.mockResolvedValue({ fileId: 1, url: '/uploads/freeform/a.jpg' });
  URL.createObjectURL = vi.fn(() => 'blob:preview');
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreateObjectURL;
});

function pickFiles(files: File[]) {
  const input = screen.getByTestId('source-file-input') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

function heicFiles(count: number) {
  return Array.from(
    { length: count },
    (_, i) => new File(['x'], `p${i}.heic`, { type: 'image/heic' }),
  );
}

function recognizeButton() {
  return screen.getByRole('button', { name: '开始识题' });
}

describe('SolveSourceInput', () => {
  it('HEIC 转 JPEG 后上传，最多 6 张', async () => {
    const onRecognize = vi.fn();
    render(<SolveSourceInput busy={false} onRecognize={onRecognize} />);

    pickFiles(heicFiles(7));

    await waitFor(() => expect(screen.getAllByTestId('source-thumb')).toHaveLength(6));
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(6));

    // HEIC → JPEG，且来源标记为 freeform
    expect(ensureJpegMock).toHaveBeenCalledTimes(6);
    const [uploaded, , source] = uploadFileMock.mock.calls[0];
    expect(uploaded.type).toBe('image/jpeg');
    expect(uploaded.name).toBe('p0.jpg');
    expect(source).toBe('freeform');

    fireEvent.click(recognizeButton());

    await waitFor(() => expect(onRecognize).toHaveBeenCalled());
    expect(onRecognize.mock.calls[0][0].attachments).toHaveLength(6);
    expect(onRecognize.mock.calls[0][0].imageUrls).toHaveLength(6);
  });

  it('文字非空也可提交（attachments 为空数组）', () => {
    const onRecognize = vi.fn();
    render(<SolveSourceInput busy={false} onRecognize={onRecognize} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '第5题' } });
    fireEvent.click(recognizeButton());

    expect(onRecognize).toHaveBeenCalledWith(
      expect.objectContaining({ text: '第5题', attachments: [] }),
    );
    expect(onRecognize.mock.calls[0][0].imageUrls).toEqual([]);
  });

  it('按选择顺序提交；删中间一张后序号前移', async () => {
    let seq = 0;
    uploadFileMock.mockImplementation(async () => {
      seq += 1;
      return { fileId: seq, url: `/uploads/freeform/${seq}.jpg` };
    });

    const onRecognize = vi.fn();
    render(<SolveSourceInput busy={false} onRecognize={onRecognize} />);

    pickFiles([
      new File(['x'], 'a.jpg', { type: 'image/jpeg' }),
      new File(['x'], 'b.jpg', { type: 'image/jpeg' }),
      new File(['x'], 'c.jpg', { type: 'image/jpeg' }),
    ]);

    await waitFor(() => expect(screen.getAllByTestId('source-thumb')).toHaveLength(3));
    await waitFor(() => expect(recognizeButton()).toBeEnabled());

    const thumbs = screen.getAllByTestId('source-thumb');
    expect(within(thumbs[0]).getByText('1')).toBeInTheDocument();
    expect(within(thumbs[1]).getByText('2')).toBeInTheDocument();
    expect(within(thumbs[2]).getByText('3')).toBeInTheDocument();

    fireEvent.click(within(thumbs[1]).getByRole('button', { name: '移除图片' }));

    const remaining = screen.getAllByTestId('source-thumb');
    expect(remaining).toHaveLength(2);
    expect(within(remaining[0]).getByText('1')).toBeInTheDocument();
    expect(within(remaining[1]).getByText('2')).toBeInTheDocument();

    fireEvent.click(recognizeButton());

    expect(onRecognize).toHaveBeenCalledWith({
      text: '',
      attachments: [
        { type: 'image', fileId: '1' },
        { type: 'image', fileId: '3' },
      ],
      imageUrls: ['/uploads/freeform/1.jpg', '/uploads/freeform/3.jpg'],
    });
  });
});
