// apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx
// Task 10：五字段编辑抽屉的渲染/状态机回归钉子。
// 重点：五字段 token 隔离（传图只回写发起字段）、四个保存禁用条件、不回填常驻提示、
// 取消清理只删本次会话上传的 URL、软上限 6 张仍允许、`/uploads/` 预览透传。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ResearchQuestionEditDrawer from '../ResearchQuestionEditDrawer';
import {
  deleteResearchImages,
  updateResearchQuestion,
  uploadResearchImage,
  type ResearchQuestionDetail,
  type ResearchQuestionUpdateResult,
} from '@/services/api';
import { toast } from '@/components/base/Toast';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    updateResearchQuestion: vi.fn(),
    uploadResearchImage: vi.fn(),
    deleteResearchImages: vi.fn(),
  };
});
vi.mock('@/utils/image-compress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/image-compress')>();
  return { ...actual, compressImageFile: vi.fn(async (f: File) => f) };
});
vi.mock('@/components/base/Toast', () => ({ toast: vi.fn() }));

const updateMock = vi.mocked(updateResearchQuestion);
const uploadMock = vi.mocked(uploadResearchImage);
const deleteMock = vi.mocked(deleteResearchImages);
const toastMock = vi.mocked(toast);

const FIXED_URL = '/uploads/research/a1b2.png';

function q(over: Partial<ResearchQuestionDetail> = {}): ResearchQuestionDetail {
  return {
    id: 42,
    questionNo: 3,
    type: 'choice',
    content: '题干原文',
    options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }],
    answer: 'B',
    explanation: '解析原文',
    approach: '思路原文',
    source: '某校',
    sourceYear: 2026,
    answerVerified: true,
    isActive: true,
    ...over,
  };
}

function renderDrawer(question = q(), onClose = vi.fn(), onSaved = vi.fn()) {
  return { onClose, onSaved, ...render(<ResearchQuestionEditDrawer question={question} onClose={onClose} onSaved={onSaved} />) };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLTextAreaElement;
const saveButton = () => screen.getByRole('button', { name: '保存' });
const checkSource = () => screen.getByLabelText('已对照原卷') as HTMLInputElement;

/** 在指定字段的上传控件塞入文件（五个字段各自独立）。 */
function uploadInto(label: string, files: File[]) {
  const wrapper = field(label).closest('[data-field]') as HTMLElement;
  const input = within(wrapper).getByLabelText(`上传图片到${label}`) as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

function imageFile(name = 'x.png', type = 'image/png'): File {
  return new File(['bytes'], name, { type });
}

/** 抽屉本身和 ConfirmDialog 都带 role=dialog，且确认框嵌在抽屉内。
 *  两者 textContent 都含提示语，取最内层（aria-modal=true）的那个。 */
function confirmDialog() {
  const dialogs = screen.getAllByRole('dialog').filter((el) => el.textContent?.includes('丢弃未保存的修改？'));
  const dialog = dialogs[dialogs.length - 1];
  if (!dialog) throw new Error('未找到丢弃确认框');
  return dialog;
}

beforeEach(() => {
  uploadMock.mockReset().mockResolvedValue({ fileId: 1, url: FIXED_URL });
  updateMock.mockReset().mockResolvedValue({
    question: { id: 42, answerVerified: true },
    changedFields: ['answer'],
    deletedImages: 0,
  });
  deleteMock.mockReset().mockResolvedValue({ deleted: 0, skipped: 0 });
  toastMock.mockClear();
});

// globals:false → @testing-library/react 不自动 cleanup，多用例必须自己清，否则 DOM 泄漏串命中。
afterEach(() => {
  cleanup();
});

describe('ResearchQuestionEditDrawer 保存禁用四个条件', () => {
  it('未勾「已对照原卷」时保存禁用（brief 示例）', async () => {
    const user = userEvent.setup();
    renderDrawer();

    expect(saveButton()).toBeDisabled();
    await user.type(field('标准答案'), 'C');
    expect(saveButton()).toBeDisabled(); // 仍未勾选
    await user.click(checkSource());
    expect(saveButton()).toBeEnabled();
  });

  it('条件一：无任何字段变更，即便勾了「已对照原卷」仍禁用', () => {
    renderDrawer();
    fireEvent.click(checkSource());
    expect(saveButton()).toBeDisabled();
  });

  it('条件三：有上传在 flight 时禁用；上传完成后恢复可用', async () => {
    let finishUpload!: (value: { fileId: number; url: string }) => void;
    uploadMock.mockImplementation(() => new Promise((resolve) => { finishUpload = resolve; }));
    renderDrawer();
    fireEvent.click(checkSource());
    fireEvent.change(field('标准答案'), { target: { value: 'A' } });
    expect(saveButton()).toBeEnabled();

    uploadInto('解析', [imageFile()]);
    expect(saveButton()).toBeDisabled();
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));

    await act(async () => { finishUpload({ fileId: 7, url: FIXED_URL }); });
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });

  it('条件四：saving 中禁用；成功后 onSaved 一次，body 只含变更字段 + note', async () => {
    let finishSave!: (value: ResearchQuestionUpdateResult) => void;
    updateMock.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    const { onSaved } = renderDrawer();
    fireEvent.change(field('标准答案'), { target: { value: 'A' } });
    fireEvent.change(screen.getByPlaceholderText('备注（写审计）'), { target: { value: '对照原卷' } });
    fireEvent.click(checkSource());

    fireEvent.click(saveButton());
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledWith(42, {
      answer: 'A',
      confirmedSource: true,
      note: '对照原卷',
    });
    expect(saveButton()).toBeDisabled();
    expect(onSaved).not.toHaveBeenCalled();

    await act(async () => {
      finishSave({ question: { id: 42, answerVerified: true }, changedFields: ['answer'], deletedImages: 0 });
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe('ResearchQuestionEditDrawer 状态机', () => {
  it('保存失败 → error + toast，抽屉仍在、可重试，不触发 onSaved', async () => {
    updateMock.mockRejectedValueOnce(new Error('服务异常'));
    const { onSaved } = renderDrawer();
    fireEvent.change(field('标准答案'), { target: { value: 'A' } });
    fireEvent.click(checkSource());

    fireEvent.click(saveButton());
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '服务异常'));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-status', 'error');
    expect(onSaved).not.toHaveBeenCalled();
    expect(saveButton()).toBeEnabled(); // 可重试

    fireEvent.click(saveButton());
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(2));
  });

  it('选项 JSON 非法 → 停在可编辑态并提示，不调 PATCH', () => {
    renderDrawer();
    fireEvent.change(field('选项'), { target: { value: 'not json' } });
    fireEvent.click(checkSource());
    fireEvent.click(saveButton());
    expect(toastMock).toHaveBeenCalledWith('error', expect.stringContaining('选项'));
    expect(updateMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveAttribute('data-status', 'editing');
  });
});

describe('ResearchQuestionEditDrawer 静态提示与预览', () => {
  const NOTICE = '本次修正仅影响之后的判题，不会修改已有作答记录、错题本、积分与掌握度。';

  it('常驻显示不回填提示，且不可关闭', () => {
    renderDrawer();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByText(/仅影响之后的判题/)).toBeInTheDocument();
    expect(document.querySelector('.static-notice')).toHaveTextContent(NOTICE);
  });

  it('编辑/上传后提示仍在', async () => {
    renderDrawer();
    fireEvent.change(field('标准答案'), { target: { value: 'A' } });
    uploadInto('解析', [imageFile()]);
    await waitFor(() => expect(field('解析').value).toContain(FIXED_URL));
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it('预览走统一 markdown 管线：/uploads/ 路径原样透传，不补 /assets/', () => {
    renderDrawer(q({ explanation: '读图 ![示意](/uploads/research/old.png) 后作答' }));
    const img = within(screen.getByTestId('preview-explanation')).getByRole('img');
    expect(img).toHaveAttribute('src', '/uploads/research/old.png');
  });
});

describe('ResearchQuestionEditDrawer 五字段 token 隔离', () => {
  it('在解析字段上传 → url 只出现在解析末尾，答案字段不变', async () => {
    renderDrawer();
    const answerBefore = field('标准答案').value;

    uploadInto('解析', [imageFile()]);
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(field('解析').value).toContain(FIXED_URL));

    expect(field('解析').value).toMatch(/!\[图1\]\(\/uploads\/research\/a1b2\.png\)$/);
    expect(field('标准答案').value).toBe(answerBefore);
    expect(field('题干').value).toBe('题干原文');
    expect(field('思路').value).toBe('思路原文');
  });

  it('答案字段上传不会污染解析字段；两字段可各自独立上传', async () => {
    uploadMock
      .mockResolvedValueOnce({ fileId: 1, url: '/uploads/research/answer.png' })
      .mockResolvedValueOnce({ fileId: 2, url: '/uploads/research/explain.png' });
    renderDrawer();

    uploadInto('标准答案', [imageFile('a.png')]);
    await waitFor(() => expect(field('标准答案').value).toContain('/uploads/research/answer.png'));
    expect(field('解析').value).toBe('解析原文');

    uploadInto('解析', [imageFile('b.png')]);
    await waitFor(() => expect(field('解析').value).toContain('/uploads/research/explain.png'));
    expect(field('标准答案').value).toContain('/uploads/research/answer.png');
  });

  it('切题时 abort 在途上传并重置为新题原值（占位清理）', async () => {
    const signals: AbortSignal[] = [];
    uploadMock.mockImplementation((_file, signal) => new Promise((_resolve, reject) => {
      signals.push(signal as AbortSignal);
      (signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const { rerender } = render(<ResearchQuestionEditDrawer question={q()} onClose={vi.fn()} onSaved={vi.fn()} />);

    uploadInto('解析', [imageFile()]);
    await waitFor(() => expect(signals).toHaveLength(1));

    rerender(<ResearchQuestionEditDrawer question={q({ id: 43, explanation: '新题解析' })} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(signals[0].aborted).toBe(true));
    expect(field('解析').value).toBe('新题解析');
    expect(field('解析').value).not.toContain('__UPLOAD_');
  });
});

describe('ResearchQuestionEditDrawer 取消清理', () => {
  it('dirty 时取消先弹确认框，确认前不删图、不关闭', async () => {
    const onClose = vi.fn();
    renderDrawer(q(), onClose);
    uploadInto('解析', [imageFile()]);
    await waitFor(() => expect(field('解析').value).toContain(FIXED_URL));
    fireEvent.change(field('标准答案'), { target: { value: 'A' } });

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    const dialog = confirmDialog();
    expect(within(dialog).getByText('丢弃未保存的修改？')).toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('确认丢弃 → deleteResearchImages(仅会话 URL) + onClose', async () => {
    const onClose = vi.fn();
    renderDrawer(q(), onClose);
    uploadInto('解析', [imageFile()]);
    await waitFor(() => expect(field('解析').value).toContain(FIXED_URL));
    fireEvent.change(field('标准答案'), { target: { value: 'A' } });

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    const dialog = confirmDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith([FIXED_URL]));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('确认框点「取消」→ 不删图、不关闭、继续编辑', () => {
    const onClose = vi.fn();
    renderDrawer(q(), onClose);
    fireEvent.change(field('标准答案'), { target: { value: 'A' } });

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    const dialog = confirmDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    expect(deleteMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(field('标准答案').value).toBe('A');
  });

  it('无变更且无会话上传 → 直接关闭，不弹确认框、不调删除', () => {
    const onClose = vi.fn();
    renderDrawer(q(), onClose);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe('ResearchQuestionEditDrawer 图片校验与软上限', () => {
  it('超过 6 张仍全部上传，只 toast「图片较多，建议精简」', async () => {
    uploadMock.mockImplementation(async () => ({
      fileId: 1,
      url: `${FIXED_URL}?n=${uploadMock.mock.calls.length}`,
    }));
    renderDrawer();
    const files = Array.from({ length: 7 }, (_, i) => imageFile(`p${i}.png`));

    uploadInto('解析', files);
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(7));
    expect(toastMock).toHaveBeenCalledWith('error', '图片较多，建议精简');
    expect((field('解析').value.match(/!\[图\d+\]\(/g) ?? [])).toHaveLength(7);
  });

  it('非 image/* 文件被忽略，不发起上传', () => {
    renderDrawer();
    uploadInto('解析', [imageFile('note.txt', 'text/plain')]);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(field('解析').value).toBe('解析原文');
  });
});

describe('ResearchQuestionEditDrawer review 回归', () => {
  it('无选项题(options=null)只改 answer：保存成功且 PATCH 完全不带 options（不捏造假选项）', async () => {
    const { onSaved } = renderDrawer(q({ options: null, answer: '无答案' }));
    expect(field('选项').value).toBe(''); // null 渲染为空，不是字面 "null"

    fireEvent.change(field('标准答案'), { target: { value: 'B' } });
    fireEvent.click(checkSource());
    fireEvent.click(saveButton());

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const [id, body] = updateMock.mock.calls[0] as [number, Record<string, unknown>];
    expect(id).toBe(42);
    expect(body).toEqual({ answer: 'B', confirmedSource: true });
    expect(Object.prototype.hasOwnProperty.call(body, 'options')).toBe(false);
    expect(toastMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('原有选项的题把选项清空 → PATCH 显式 options:null（保持无选项题语义）', async () => {
    renderDrawer(q());
    fireEvent.change(field('选项'), { target: { value: '' } });
    fireEvent.click(checkSource());
    fireEvent.click(saveButton());

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledWith(42, { options: null, confirmedSource: true });
  });

  it('无选项题补上合法选项 → PATCH 带解析后的数组', async () => {
    renderDrawer(q({ options: null }));
    fireEvent.change(field('选项'), { target: { value: '[{"label":"A","text":"甲"}]' } });
    fireEvent.click(checkSource());
    fireEvent.click(saveButton());

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledWith(42, {
      options: [{ label: 'A', text: '甲' }], confirmedSource: true,
    });
  });

  it('切题后再编辑：新题其它字段不被旧题草稿覆盖（draftsRef 不得在 updater 里回写）', async () => {
    let finishUpload!: (value: { fileId: number; url: string }) => void;
    uploadMock.mockImplementation(() => new Promise((resolve) => { finishUpload = resolve; }));
    const { rerender } = render(
      <ResearchQuestionEditDrawer
        question={q({ id: 1, content: '旧题题干', answer: '旧答案', explanation: '旧解析', approach: '旧思路' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    // 旧题有在途上传：切题时占位清理的 updater 会真正干活，是 ref 被回写的最危险路径
    uploadInto('解析', [imageFile()]);
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));

    rerender(
      <ResearchQuestionEditDrawer
        question={q({ id: 2, content: '新题题干', answer: '新答案', explanation: '新解析', approach: '新思路' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await waitFor(() => expect(field('解析').value).toBe('新解析'));
    await act(async () => { finishUpload({ fileId: 9, url: '/uploads/research/late.png' }); });

    fireEvent.change(field('思路'), { target: { value: '新思路-改' } });

    expect(field('思路').value).toBe('新思路-改');
    expect(field('题干').value).toBe('新题题干');
    expect(field('标准答案').value).toBe('新答案');
    expect(field('解析').value).toBe('新解析');
    expect(field('选项').value).toBe(JSON.stringify(q().options, null, 2));
  });

  it('选项为 JSON 文本域：无上传控件，拖拽图片也不会写进 JSON', () => {
    renderDrawer();
    const optionsWrapper = field('选项').closest('[data-field]') as HTMLElement;
    expect(within(optionsWrapper).queryByLabelText('上传图片到选项')).not.toBeInTheDocument();
    expect(within(optionsWrapper).queryByRole('button', { name: '上传图片' })).not.toBeInTheDocument();

    // markdown 字段仍保留上传控件（以 MARKDOWN_FIELDS 为准）
    const analysisWrapper = field('解析').closest('[data-field]') as HTMLElement;
    expect(within(analysisWrapper).getByRole('button', { name: '上传图片' })).toBeInTheDocument();

    fireEvent.drop(field('选项'), { dataTransfer: { files: [imageFile()], types: ['Files'] } });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(field('选项').value).toBe(JSON.stringify(q().options, null, 2));
  });

  it('上传失败占位在预览中标红', async () => {
    uploadMock.mockRejectedValueOnce(new Error('网络错误'));
    renderDrawer();
    uploadInto('解析', [imageFile()]);
    await waitFor(() => expect(field('解析').value).toContain('上传失败'));

    const mark = screen.getByTestId('preview-explanation').querySelector('.research-upload-failure');
    expect(mark).not.toBeNull();
    expect(mark).toHaveTextContent('上传失败');
    expect(mark).toHaveStyle({ color: 'var(--error)' });
  });
});

// Task 1：右上角关闭按钮从文字改为 X 图标（仍走 requestCancel 的 dirty 确认）。
// 复用本文件既有的 renderDrawer / mocks / afterEach，不另起一套，避免 mock 冲突。
describe('ResearchQuestionEditDrawer 关闭按钮', () => {
  it('右上角是带 aria-label 的 X 图标按钮，不是文字按钮', () => {
    renderDrawer();
    const btn = screen.getByRole('button', { name: '关闭抽屉' });
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent).toBe('');
  });

  it('干净态点 X → 关闭', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dirty 态点 X → 弹丢弃确认框，不直接关闭', () => {
    const { onClose } = renderDrawer();
    fireEvent.change(screen.getByRole('textbox', { name: '题干' }), {
      target: { value: '改过的题干' },
    });
    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));
    expect(screen.getByText('丢弃未保存的修改？')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Task 2：左缘拖拽调宽。jsdom 无 PointerEvent 实现、getBoundingClientRect 恒 0，
// 这两个桩只在本 describe 内生效（beforeEach 装、afterEach restore），不污染上面 27 个用例。
describe('ResearchQuestionEditDrawer 拖拽调宽', () => {
  const MOCK_RECT = {
    width: 512, height: 800, x: 0, y: 0, top: 0, left: 0,
    right: 512, bottom: 800, toJSON: () => ({}),
  } as DOMRect;

  // defineProperty 装的桩 restoreAllMocks() 不会撤销；存原始 descriptor 手动还原，
  // 避免泄漏到本 describe 之后追加的用例（原属性若继承自原型则删掉自身属性还原继承）。
  let originalSetPointerCapture: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalSetPointerCapture = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'setPointerCapture');
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(MOCK_RECT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSetPointerCapture) {
      Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', originalSetPointerCapture);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture');
    }
  });

  function dragSeparator(fromX: number, toX: number) {
    const sep = screen.getByRole('separator', { name: '调整抽屉宽度' });
    fireEvent.pointerDown(sep, { clientX: fromX, pointerId: 1, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(sep, { clientX: toX, pointerId: 1 });
    fireEvent.pointerUp(sep, { clientX: toX, pointerId: 1 });
  }

  it('左缘有竖向拖拽条', () => {
    renderDrawer();
    const sep = screen.getByRole('separator', { name: '调整抽屉宽度' });
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('向左拖变宽、向右拖变窄，并夹紧到 360..92vw', () => {
    renderDrawer();
    dragSeparator(500, 400); // 512 + (500-400) = 612
    expect(screen.getByRole('dialog', { name: /编辑题目/ }).style.width).toBe('612px');
    dragSeparator(500, 900); // 512 + (500-900) = -388 → 夹紧到下限 360
    expect(screen.getByRole('dialog', { name: /编辑题目/ }).style.width).toBe('360px');
  });

  it('会话记忆：拖拽后卸载再挂载仍保留宽度', () => {
    const first = renderDrawer();
    dragSeparator(500, 420); // 512 + 80 = 592
    expect(screen.getByRole('dialog', { name: /编辑题目/ }).style.width).toBe('592px');
    first.unmount();
    renderDrawer();
    // 模块级 lastWidthPx 在单文件内共享，重挂载读回上次宽度
    expect(screen.getByRole('dialog', { name: /编辑题目/ }).style.width).toBe('592px');
  });
});

describe('ResearchQuestionEditDrawer 选项卡片点选', () => {
  it('选择题渲染选项卡片，正文走 markdown', () => {
    renderDrawer(q({ options: [
      { label: 'A', text: '**甲**选项' },
      { label: 'B', text: '乙选项' },
    ] }));
    const cards = screen.getByTestId('choice-options');
    expect(within(cards).getByRole('button', { name: '将A设为正确答案' })).toBeInTheDocument();
    expect(within(cards).getByRole('button', { name: '将B设为正确答案' })).toBeInTheDocument();
    expect(within(cards).getByText('甲').tagName).toBe('STRONG');
  });

  it('点 A → 标准答案为 A，A 卡片 aria-pressed=true', () => {
    renderDrawer(q({ answer: '' }));
    fireEvent.click(screen.getByRole('button', { name: '将A设为正确答案' }));
    expect(field('标准答案').value).toBe('A');
    expect(screen.getByRole('button', { name: '将A设为正确答案' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('再点 A → 取消选中，答案清空', () => {
    renderDrawer(q({ answer: '' }));
    const a = screen.getByRole('button', { name: '将A设为正确答案' });
    fireEvent.click(a);
    fireEvent.click(a);
    expect(field('标准答案').value).toBe('');
    expect(a).toHaveAttribute('aria-pressed', 'false');
  });

  it('多选题点 A、C → AC；再点 A → C', () => {
    renderDrawer(q({
      type: 'multi_choice',
      options: [
        { label: 'A', text: '甲' }, { label: 'B', text: '乙' }, { label: 'C', text: '丙' },
      ],
      answer: '',
    }));
    fireEvent.click(screen.getByRole('button', { name: '将A设为正确答案' }));
    fireEvent.click(screen.getByRole('button', { name: '将C设为正确答案' }));
    expect(field('标准答案').value).toBe('AC');
    fireEvent.click(screen.getByRole('button', { name: '将A设为正确答案' }));
    expect(field('标准答案').value).toBe('C');
  });

  it('改选项 JSON → 卡片即时新增 D', () => {
    renderDrawer();
    fireEvent.change(field('选项'), {
      target: { value: JSON.stringify([
        { label: 'A', text: '甲' }, { label: 'B', text: '乙' }, { label: 'D', text: '丁' },
      ]) },
    });
    expect(screen.getByRole('button', { name: '将D设为正确答案' })).toBeInTheDocument();
  });

  it('非选项题（fill_blank + options=null）→ 无卡片', () => {
    renderDrawer(q({ type: 'fill_blank', options: null }));
    expect(screen.queryByTestId('choice-options')).not.toBeInTheDocument();
  });

  it('选项 JSON 非法 → 无卡片且不抛错', () => {
    renderDrawer();
    fireEvent.change(field('选项'), { target: { value: '{ 不是合法 JSON' } });
    expect(screen.queryByTestId('choice-options')).not.toBeInTheDocument();
  });
});
