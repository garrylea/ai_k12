import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SolveSourceInput } from './SolveSourceInput';
import { uploadFile } from '@/services/api';
import { ensureJpeg } from '@/utils/image-convert';
import { toast } from '@/components/base/Toast';

/**
 * 状态 A · 录入（spec §3.2 / §8.3）。
 *
 * 契约要点：
 * 1. HEIC 先在客户端转 JPEG 再上传，`uploadFile` 的 source 必须是 `freeform`；
 * 2. 最多 6 张（第 7 张丢弃并提示），每张 ≤5MB、仅图片；**先筛类型/大小再占名额**；
 * 3. 文字可选；纯文字提交时 `attachments` / `imageUrls` 都是空数组；
 * 4. 顺序 = 选择顺序，删中间一张后后续序号前移、提交仍按当前顺序；
 * 5. 所有图片 ready 且（有文字 或 ≥1 图）才允许「开始识题」。
 */

vi.mock('@/utils/image-convert', () => ({ ensureJpeg: vi.fn() }));

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, uploadFile: vi.fn() };
});

vi.mock('@/components/base/Toast', () => ({ toast: vi.fn() }));

const uploadFileMock = vi.mocked(uploadFile);
const ensureJpegMock = vi.mocked(ensureJpeg);
const toastMock = vi.mocked(toast);

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

let revokeObjectURLMock: ReturnType<typeof vi.fn>;

// jsdom 没有实现 `URL.createObjectURL` / `revokeObjectURL`，预览缩略图与回收都要打桩。
// 每次调用给唯一 URL，方便断言「移除时回收的是这张的 URL」。
beforeEach(() => {
  // 上个用例可能留下「永挂起 / 必定失败」的一次性实现，必须整表重置后再重新装配。
  vi.resetAllMocks();
  ensureJpegMock.mockImplementation(async (f: File) =>
    f.type === 'image/heic' || f.type === 'image/heif'
      ? new File([f], f.name.replace(/\.hei[cf]$/i, '.jpg'), { type: 'image/jpeg' })
      : f,
  );
  uploadFileMock.mockResolvedValue({ fileId: 1, url: '/uploads/freeform/a.jpg' });

  let seq = 0;
  URL.createObjectURL = vi.fn(() => `blob:preview-${(seq += 1)}`);
  revokeObjectURLMock = vi.fn();
  URL.revokeObjectURL = revokeObjectURLMock as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreateObjectURL;
  if (originalRevokeObjectURL) {
    URL.revokeObjectURL = originalRevokeObjectURL;
  } else {
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pickFiles(files: File[]) {
  const input = screen.getByTestId('source-file-input') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

function heicFiles(count: number, prefix = 'p') {
  return Array.from(
    { length: count },
    (_, i) => new File(['x'], `${prefix}${i}.heic`, { type: 'image/heic' }),
  );
}

function jpegFiles(count: number, prefix = 'j') {
  return Array.from(
    { length: count },
    (_, i) => new File(['x'], `${prefix}${i}.jpg`, { type: 'image/jpeg' }),
  );
}

/** File.size 只读，超限样本用 defineProperty 造，避免真的分配 5MB 内存。 */
function fileOfSize(name: string, type: string, size: number) {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
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
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith('error', '最多 6 张题图');

    fireEvent.click(recognizeButton());

    await waitFor(() => expect(onRecognize).toHaveBeenCalled());
    expect(onRecognize.mock.calls[0][0].attachments).toHaveLength(6);
    expect(onRecognize.mock.calls[0][0].imageUrls).toHaveLength(6);
  });

  it('首批转换未完成时再选一批，仍严格封顶 6 张', async () => {
    // 第一批的 ensureJpeg 挂起，模拟 HEIC 转换中；此时第二批必须按「已占 4 格」算余量。
    const gate = deferred<void>();
    ensureJpegMock.mockImplementation(async (f: File) => {
      if (f.name.startsWith('first')) await gate.promise;
      return new File([f], f.name.replace(/\.heic$/i, '.jpg'), { type: 'image/jpeg' });
    });

    const onRecognize = vi.fn();
    render(<SolveSourceInput busy={false} onRecognize={onRecognize} />);

    pickFiles(heicFiles(4, 'first'));
    pickFiles(heicFiles(4, 'second'));

    expect(screen.getAllByTestId('source-thumb')).toHaveLength(6);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith('error', '最多 6 张题图');
    expect(recognizeButton()).toBeDisabled();

    gate.resolve();
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(6));

    expect(screen.getAllByTestId('source-thumb')).toHaveLength(6);
    expect(
      uploadFileMock.mock.calls.map(([file]) => file.name).sort(),
      '只接受第一批 4 张 + 第二批的前 2 张',
    ).toEqual(['first0.jpg', 'first1.jpg', 'first2.jpg', 'first3.jpg', 'second0.jpg', 'second1.jpg']);

    await waitFor(() => expect(recognizeButton()).toBeEnabled());
    fireEvent.click(recognizeButton());
    expect(onRecognize.mock.calls[0][0].attachments).toHaveLength(6);
  });

  it('先按大小剔除，合法图片仍能填满 6 格', async () => {
    const oversize = fileOfSize('huge.jpg', 'image/jpeg', 5 * 1024 * 1024 + 1);

    render(<SolveSourceInput busy={false} onRecognize={vi.fn()} />);
    pickFiles([oversize, ...jpegFiles(6)]);

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(6));
    expect(screen.getAllByTestId('source-thumb')).toHaveLength(6);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith('error', '图片过大（最大 5MB）');
    expect(uploadFileMock.mock.calls.some(([file]) => file.name === 'huge.jpg')).toBe(false);
  });

  it('非图片文件被忽略，不占缩略图也不上传', async () => {
    render(<SolveSourceInput busy={false} onRecognize={vi.fn()} />);
    pickFiles([
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      new File(['x'], 'a.png', { type: 'image/png' }),
    ]);

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    expect(screen.getAllByTestId('source-thumb')).toHaveLength(1);
    expect(ensureJpegMock).toHaveBeenCalledTimes(1);
    // 整批只提示一次，不按文件逐条刷屏
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith('error', '仅支持图片文件');
  });

  it('GIF 被客户端拒绝（accept 与筛选都不收），不占缩略图也不上传', async () => {
    render(<SolveSourceInput busy={false} onRecognize={vi.fn()} />);

    const input = screen.getByTestId('source-file-input') as HTMLInputElement;
    expect(input.accept).not.toContain('gif');

    pickFiles([new File(['x'], 'a.gif', { type: 'image/gif' })]);

    // 全批都不是允许的图片类型：既不上传也不占格（与其它非图片文件同一处理）。
    expect(screen.queryAllByTestId('source-thumb')).toHaveLength(0);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('展示个人信息提示', () => {
    render(<SolveSourceInput busy={false} onRecognize={vi.fn()} />);
    expect(screen.getByText('请勿上传含姓名、学校等个人信息的照片')).toBeInTheDocument();
  });

  it('转换与上传期间禁止提交', async () => {
    const convertGate = deferred<File>();
    const uploadGate = deferred<{ fileId: number; url: string }>();
    ensureJpegMock.mockImplementationOnce(() => convertGate.promise);
    uploadFileMock.mockImplementationOnce(() => uploadGate.promise);

    render(<SolveSourceInput busy={false} onRecognize={vi.fn()} />);
    pickFiles(jpegFiles(1));

    await waitFor(() => expect(screen.getAllByTestId('source-thumb')).toHaveLength(1));
    expect(recognizeButton()).toBeDisabled(); // converting

    convertGate.resolve(new File(['x'], 'j0.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    expect(recognizeButton()).toBeDisabled(); // uploading

    uploadGate.resolve({ fileId: 7, url: '/uploads/freeform/7.jpg' });
    await waitFor(() => expect(recognizeButton()).toBeEnabled());
  });

  it('上传失败后未移除失败图时禁止提交', async () => {
    uploadFileMock.mockRejectedValue(new Error('boom'));
    const onRecognize = vi.fn();

    render(<SolveSourceInput busy={false} onRecognize={onRecognize} />);
    pickFiles(jpegFiles(1));

    await waitFor(() => expect(screen.getByText('失败')).toBeInTheDocument());
    expect(recognizeButton()).toBeDisabled();

    fireEvent.click(recognizeButton());
    expect(onRecognize).not.toHaveBeenCalled();
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

  it('按选择顺序提交；删中间一张后序号前移并回收预览 URL', async () => {
    let seq = 0;
    uploadFileMock.mockImplementation(async () => {
      seq += 1;
      return { fileId: seq, url: `/uploads/freeform/${seq}.jpg` };
    });

    const onRecognize = vi.fn();
    render(<SolveSourceInput busy={false} onRecognize={onRecognize} />);

    pickFiles(jpegFiles(3, 'abc'));

    await waitFor(() => expect(screen.getAllByTestId('source-thumb')).toHaveLength(3));
    await waitFor(() => expect(recognizeButton()).toBeEnabled());

    const thumbs = screen.getAllByTestId('source-thumb');
    expect(within(thumbs[0]).getByText('第 1 页')).toBeInTheDocument();
    expect(within(thumbs[1]).getByText('第 2 页')).toBeInTheDocument();
    expect(within(thumbs[2]).getByText('第 3 页')).toBeInTheDocument();

    const removedPreview = within(thumbs[1]).getByRole('img').getAttribute('src');
    fireEvent.click(within(thumbs[1]).getByRole('button', { name: '移除图片' }));
    expect(revokeObjectURLMock).toHaveBeenCalledWith(removedPreview);

    const remaining = screen.getAllByTestId('source-thumb');
    expect(remaining).toHaveLength(2);
    expect(within(remaining[0]).getByText('第 1 页')).toBeInTheDocument();
    expect(within(remaining[1]).getByText('第 2 页')).toBeInTheDocument();

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

  it('错误态：仅有回调时渲染「重试 / 手动输入题目」，busy 时禁用', () => {
    const { unmount } = render(<SolveSourceInput busy error="识别失败" onRecognize={vi.fn()} />);
    expect(screen.getByText('识别失败')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.queryByRole('button', { name: '手动输入题目' })).toBeNull();
    unmount();

    render(
      <SolveSourceInput
        busy
        error="识别失败"
        onRetry={vi.fn()}
        onManual={vi.fn()}
        onRecognize={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '重试' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '手动输入题目' })).toBeDisabled();
  });
});
