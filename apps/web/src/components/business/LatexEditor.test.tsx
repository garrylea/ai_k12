// apps/web/src/components/business/LatexEditor.test.tsx
// 覆盖数学作答输入框的符号面板插入行为：分类讨论（分段函数）大括号模板能插入、
// 光标落在空位、且插入结果经预览管线渲染不报 KaTeX 错（模板里 $$ 独占行 / 末尾换行
// 这两条约束一旦被改动就会在这里失败）。
// 另覆盖滚动行为：① 粘贴 / IME 提交（insertText 路径）Chrome 不做光标跟随，
// 输入后光标在末尾且溢出时必须钉到底部（2026-09-22 bug：插入点在可视区外）；
// ② 输入区滚动要写入 scrollSync 比例并重放预览（左输入 → 右预览的比例跟随通道）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { LatexEditor } from './LatexEditor';
import { autoWrapMath } from './LatexPreview';
import type { PreviewScrollSync } from './preview-scroll-sync';
import { markdownRemarkPluginsWithBreaks, markdownRehypePlugins, markdownComponents } from '@/components/markdown';
import { uploadFile } from '@/services/api';
import { ensureJpeg } from '@/utils/image-convert';
import { toast } from '@/components/base/Toast';

// 贴图链路的外部依赖全部打桩：测试只验证「占位-上传-替换」的文本状态机，
// 真上传会打网络、真压缩要 canvas 布局、真 toast 要挂载容器。
vi.mock('@/services/api', () => ({ uploadFile: vi.fn() }));
vi.mock('@/utils/image-convert', () => ({
  // 真实实现里 HEIC 会转成 JPEG；mock 也要模拟这一点，否则断言上传物类型时失真
  ensureJpeg: vi.fn(async (f: File) =>
    f.type === 'image/heic'
      ? new File([f], f.name.replace(/\.heic$/i, '.jpg'), { type: 'image/jpeg' })
      : f,
  ),
}));
vi.mock('@/utils/image-compress', () => ({
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  compressImageFile: vi.fn(async (f: File) => f),
}));
vi.mock('@/components/base/Toast', () => ({ toast: vi.fn() }));

// vitest globals:false 下需手动 cleanup，避免上个用例 DOM 泄漏导致重复命中。
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** jsdom 无布局：用实例属性覆写滚动几何，返回可断言的 scrollTop 视图 */
function mockScrollGeometry(el: HTMLElement, geo: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  let top = geo.scrollTop;
  Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = v; }, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { get: () => geo.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => geo.clientHeight, configurable: true });
  return { get scrollTop() { return top; } };
}

function renderEditor() {
  function Wrapper() {
    const [value, setValue] = useState('');
    return <LatexEditor value={value} onChange={setValue} />;
  }
  render(<Wrapper />);
  return screen.getByRole('textbox');
}

/** 点符号面板里 label 为 label 的按钮 */
async function clickSymbol(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('button', { name: label }));
}

describe('LatexEditor 符号面板', () => {
  it('插入分类讨论大括号模板：含 cases 环境、无 $0 标记残留', async () => {
    const user = userEvent.setup();
    const ta = renderEditor();

    await clickSymbol(user, '{');

    const value = (ta as HTMLTextAreaElement).value;
    expect(value).toContain('\\begin{cases}');
    expect(value).toContain('\\end{cases}');
    expect(value).not.toContain('$0');
  });

  it('插入后光标落在第一行空位（$0 标记处），不在模板末尾', async () => {
    const user = userEvent.setup();
    const ta = renderEditor();

    await clickSymbol(user, '{');

    const el = ta as HTMLTextAreaElement;
    // 光标在 requestAnimationFrame 里才落位；React 写入 value 后 jsdom 先把
    // selectionStart 放在末尾，所以这里必须等「光标之后是 & 换行」这个目标状态，
    // 不能用 selectionStart > 0 之类的弱条件（末尾也满足）。
    await waitFor(() => expect(el.value.slice(el.selectionStart).startsWith(' & \\')).toBe(true));
    expect(el.selectionStart).toBeGreaterThan(0);
    expect(el.selectionStart).toBeLessThan(el.value.length);
  });

  it('模板经预览管线渲染为 display 公式且不报 KaTeX 错', async () => {
    const user = userEvent.setup();
    const ta = renderEditor();

    await clickSymbol(user, '{');
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={markdownRemarkPluginsWithBreaks}
        rehypePlugins={markdownRehypePlugins}
        components={markdownComponents}
      >
        {autoWrapMath((ta as HTMLTextAreaElement).value)}
      </ReactMarkdown>,
    );

    expect(html).toContain('katex-display');
    expect(html).not.toContain('katex-error');
  });

  it('保留既有 {} 占位规则：\\frac 插入后光标落在花括号内', async () => {
    const user = userEvent.setup();
    const ta = renderEditor();

    await clickSymbol(user, '½');

    const el = ta as HTMLTextAreaElement;
    expect(el.value).toBe('\\frac{}{}');
    await waitFor(() => expect(el.selectionStart).toBe(6));
  });
});

describe('LatexEditor 滚动跟随', () => {
  it('输入后光标在末尾且内容溢出：视口钉到底部（Chrome 粘贴/IME 路径不跟随，实测插入点在可视区外）', async () => {
    const user = userEvent.setup();
    const ta = renderEditor();
    const el = ta as HTMLTextAreaElement;
    const geo = mockScrollGeometry(el, { scrollTop: 0, scrollHeight: 800, clientHeight: 300 });

    await user.type(el, 'abc');

    expect(geo.scrollTop).toBe(800);
  });

  it('光标不在末尾的编辑不强制滚动（浏览器原生跟随，不干预）', async () => {
    const user = userEvent.setup();
    function Wrapper() {
      const [value, setValue] = useState('abcdef');
      return <LatexEditor value={value} onChange={setValue} />;
    }
    render(<Wrapper />);
    const el = screen.getByRole('textbox') as HTMLTextAreaElement;
    const geo = mockScrollGeometry(el, { scrollTop: 120, scrollHeight: 800, clientHeight: 300 });

    // userEvent.type 会先 click（jsdom 里 click 把光标重置到末尾），改用 keyboard
    // 直接往已聚焦元素打字，保持「光标在中间」的前置条件
    el.focus();
    el.setSelectionRange(3, 3);
    await user.keyboard('x');

    expect(geo.scrollTop).toBe(120); // 不被钉到底
  });

  it('滚动写入 scrollSync 比例并重放预览', () => {
    const sync: { current: PreviewScrollSync } = { current: { ratio: -1, apply: vi.fn() } };
    render(<LatexEditor value="" onChange={() => {}} scrollSync={sync} />);
    const el = screen.getByRole('textbox') as HTMLTextAreaElement;
    mockScrollGeometry(el, { scrollTop: 250, scrollHeight: 800, clientHeight: 300 }); // 250/500 = 0.5

    fireEvent.scroll(el);

    expect(sync.current.ratio).toBe(0.5);
    expect(sync.current.apply).toHaveBeenCalledTimes(1);
  });

  it('输入区无滚动条时不写比例、不重放（无「跟随」语义，不动预览）', () => {
    const sync: { current: PreviewScrollSync } = { current: { ratio: -1, apply: vi.fn() } };
    render(<LatexEditor value="" onChange={() => {}} scrollSync={sync} />);
    const el = screen.getByRole('textbox') as HTMLTextAreaElement;
    mockScrollGeometry(el, { scrollTop: 0, scrollHeight: 300, clientHeight: 300 });

    fireEvent.scroll(el);

    expect(sync.current.ratio).toBe(-1);
    expect(sync.current.apply).not.toHaveBeenCalled();
  });

  it('符号模板插在内容末尾（光标落在占位符内）也钉到底部：插入点必须可见', async () => {
    const user = userEvent.setup();
    function Wrapper() {
      const [value, setValue] = useState('abc');
      return <LatexEditor value={value} onChange={setValue} />;
    }
    render(<Wrapper />);
    const el = screen.getByRole('textbox') as HTMLTextAreaElement;
    const geo = mockScrollGeometry(el, { scrollTop: 0, scrollHeight: 800, clientHeight: 300 });

    el.focus();
    el.setSelectionRange(3, 3); // 光标放内容末尾（jsdom 默认在 0）
    await user.click(screen.getByRole('button', { name: '½' })); // \frac{}{} 插到末尾，光标在 {} 内

    await waitFor(() => expect(el.value).toBe('abc\\frac{}{}'));
    // 钉底发生在 requestAnimationFrame 里，等它落地再断言（同上「光标落位」用例）
    await waitFor(() => expect(geo.scrollTop).toBe(800));
  });

  it('符号模板插在内容中间不钉底（浏览器原生跟随，不干预）', async () => {
    const user = userEvent.setup();
    function Wrapper() {
      const [value, setValue] = useState('abcdef');
      return <LatexEditor value={value} onChange={setValue} />;
    }
    render(<Wrapper />);
    const el = screen.getByRole('textbox') as HTMLTextAreaElement;
    const geo = mockScrollGeometry(el, { scrollTop: 100, scrollHeight: 800, clientHeight: 300 });

    el.focus();
    el.setSelectionRange(0, 0); // 光标放开头
    await user.click(screen.getByRole('button', { name: '½' }));

    await waitFor(() => expect(el.value).toBe('\\frac{}{}abcdef'));
    // rAF 已跑完（value 断言之后给一拍），插入点不在末尾，不强制滚动
    await new Promise(r => setTimeout(r, 50));
    expect(geo.scrollTop).toBe(100);
  });
});

// --- 贴图：粘贴 / 拖拽 → 纯文本占位 → 上传成功替换为 Markdown 图片 ---
// 为什么占位是纯文本而不是 ![](...)：占位一旦写成图片语法，预览区会先请求一个
// 还不存在的 URL（破图闪现）。编号必须可扫描，否则同一次粘贴里的两张会撞号。

const img = (name = 'a.png', type = 'image/png', bytes = 10) => new File([new Uint8Array(bytes)], name, { type });

/** 直接构造 paste 事件：jsdom 的 ClipboardEvent 不认 clipboardData 初始化，键要手挂 */
function pasteImages(el: HTMLElement, files: File[]) {
  const evt = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
    clipboardData?: unknown;
  };
  Object.defineProperty(evt, 'clipboardData', {
    value: { items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })) },
  });
  return fireEvent(el, evt);
}

function dropFiles(el: HTMLElement, files: File[]) {
  const evt = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown };
  Object.defineProperty(evt, 'dataTransfer', { value: { files, types: ['Files'] } });
  return fireEvent(el, evt);
}

function renderControlled(initial = '', extra?: { onUploadingChange?: (v: boolean) => void }) {
  const onChange = vi.fn();
  function Wrapper() {
    const [v, setV] = useState(initial);
    return (
      <LatexEditor
        value={v}
        onChange={(n) => { setV(n); onChange(n); }}
        onUploadingChange={extra?.onUploadingChange}
      />
    );
  }
  render(<Wrapper />);
  return { el: screen.getByRole('textbox') as HTMLTextAreaElement, onChange };
}

describe('LatexEditor 贴图', () => {
  it('粘贴图片：占位插在光标处，上传成功后替换为 Markdown 图片', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ fileId: 7, url: '/uploads/auxiliary/a.jpg' });
    const { el } = renderControlled('12V;2A');
    el.focus();
    el.setSelectionRange(3, 3); // "12V" 之后
    pasteImages(el, [img()]);

    await waitFor(() => expect(el.value).toContain('![图1](/uploads/auxiliary/a.jpg)'));
    expect(el.value.startsWith('12V')).toBe(true);
    expect(el.value).not.toContain('上传中');
  });

  it('一次粘贴两张：只触发一次 onChange（避免受控组件光标漂移），编号顺延', async () => {
    vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {})); // 永挂起
    const { el, onChange } = renderControlled('起点');
    onChange.mockClear();
    pasteImages(el, [img('a.png'), img('b.png')]);

    await waitFor(() => expect(el.value).toContain('［图1 上传中…］'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(el.value).toContain('［图2 上传中…］');
  });

  it('上传失败：占位替换为失败标记并 toast，不抛', async () => {
    vi.mocked(uploadFile).mockRejectedValue(new Error('boom'));
    const { el } = renderControlled('');
    pasteImages(el, [img()]);

    await waitFor(() => expect(el.value).toContain('［图1 上传失败］'));
    expect(vi.mocked(toast)).toHaveBeenCalledWith('error', '图片上传失败，请重试');
  });

  it('纯文本剪贴板：不拦截默认行为，不上传', () => {
    const { el } = renderControlled('');
    const evt = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
    Object.defineProperty(evt, 'clipboardData', {
      value: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
    });
    const notPrevented = fireEvent(el, evt);
    expect(notPrevented).toBe(true);
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled();
  });

  it('编号防撞：已有失败标记时，新图从 2 开始', async () => {
    vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
    const { el } = renderControlled('［图1 上传失败］');
    pasteImages(el, [img()]);
    await waitFor(() => expect(el.value).toContain('［图2 上传中…］'));
  });

  it('超过 5MB：不调用上传，toast，文本不变', () => {
    const { el } = renderControlled('');
    pasteImages(el, [img('big.png', 'image/png', 6 * 1024 * 1024)]);
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled();
    expect(vi.mocked(toast)).toHaveBeenCalledWith('error', '图片过大（最大 5MB）');
    expect(el.value).toBe('');
  });

  it('上传途中学生删掉占位：结果丢弃，不追加', async () => {
    let resolve!: (v: { fileId: number; url: string }) => void;
    vi.mocked(uploadFile).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { el } = renderControlled('');
    pasteImages(el, [img()]);
    await waitFor(() => expect(el.value).toContain('上传中'));

    fireEvent.change(el, { target: { value: '' } });
    resolve({ fileId: 1, url: '/uploads/x.jpg' });

    await waitFor(() => expect(vi.mocked(uploadFile)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(el.value).toBe('');
  });

  it('拖入图片文件：与粘贴同一路径', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ fileId: 1, url: '/uploads/auxiliary/d.jpg' });
    const { el } = renderControlled('');
    dropFiles(el, [img()]);
    await waitFor(() => expect(el.value).toContain('![图1](/uploads/auxiliary/d.jpg)'));
  });

  it('HEIC 先转 JPEG 再上传', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ fileId: 1, url: '/uploads/auxiliary/h.jpg' });
    const { el } = renderControlled('');
    pasteImages(el, [img('h.heic', 'image/heic')]);
    await waitFor(() => expect(vi.mocked(ensureJpeg)).toHaveBeenCalled());
    // 上传物必须是转换后的 JPEG：iOS 截图直接拖进来是 HEIC，服务端认不出
    expect(vi.mocked(uploadFile).mock.calls[0][0].type).toBe('image/jpeg');
  });

  it('上传中回调 true，完成后 false（上层据此禁用提交）', async () => {
    let resolve!: (v: { fileId: number; url: string }) => void;
    vi.mocked(uploadFile).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const onUploadingChange = vi.fn();
    const { el } = renderControlled('', { onUploadingChange });
    pasteImages(el, [img()]);
    await waitFor(() => expect(onUploadingChange).toHaveBeenCalledWith(true));
    resolve({ fileId: 1, url: '/uploads/x.jpg' });
    await waitFor(() => expect(onUploadingChange).toHaveBeenCalledWith(false));
  });
});
