import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ParentAccountPage from './ParentAccountPage';
import { toast } from '@/components/base';
import {
  ApiError,
  changeParentPassword,
  getParentAccount,
  type ParentAccount,
} from '@/services/api';

/**
 * 家长端「账号设置」P6.10（spec §5.4 / plan Task 8）。
 *
 * 契约要点：
 * 1. 账号信息**只读** —— 卡里不许出现任何可编辑控件（PRD 无「家长改手机号/姓名」的要求）。
 * 2. 改密码三段本地校验（旧非空 / 新 6..32 / 两次一致）→ 不过就**不发请求**。
 * 3. 成功 → `toast('success','密码已修改')` + **清空三个输入框**。
 * 4. `1003`（旧密码错）→ 错误标在**旧密码框**上；其余失败只给 toast，不冤枉任何一格。
 * 5. 退出登录复用 `LogoutButton`（鉴权清理只有那一处实现）。
 */

const ACCOUNT: ParentAccount = { id: 7, name: '张三', phone: '13800000000' };

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  // 只替换 toast：Input/Card/Button/LogoutButton 必须是真的（要断言 Input 的 error 行内文案）。
  return { ...actual, toast: vi.fn() };
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getParentAccount: vi.fn(),
    changeParentPassword: vi.fn(),
  };
});

const getAccountMock = vi.mocked(getParentAccount);
const changePasswordMock = vi.mocked(changeParentPassword);
const toastMock = vi.mocked(toast);

function renderPage() {
  return render(
    <MemoryRouter>
      <ParentAccountPage />
    </MemoryRouter>,
  );
}

/** 填三个密码框（只填给定的，其余留空）。 */
function fillPasswords(old: string, next: string, confirm: string) {
  fireEvent.change(screen.getByTestId('old-password-input'), { target: { value: old } });
  fireEvent.change(screen.getByTestId('new-password-input'), { target: { value: next } });
  fireEvent.change(screen.getByTestId('confirm-password-input'), { target: { value: confirm } });
}

/**
 * 取某一格密码框的**整格容器**（`Input` 的 `error` 文案是内层边框 div 的兄弟节点，
 * 所以 `closest('div')` 取到的是边框层、要再上溯一层才是「标签+输入+报错」这一整格）。
 */
function fieldWrapper(testId: string): HTMLElement {
  const box = screen.getByTestId(testId).closest('div')?.parentElement;
  if (!box) throw new Error(`找不到 ${testId} 的容器`);
  return box;
}

beforeEach(() => {
  localStorage.clear();
  getAccountMock.mockReset();
  getAccountMock.mockResolvedValue(ACCOUNT);
  changePasswordMock.mockReset();
  changePasswordMock.mockResolvedValue(null);
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ParentAccountPage：渲染', () => {
  it('账号信息只读（姓名/手机号是文本，卡内无可编辑控件）+ 改密码表单 + 退出登录', async () => {
    renderPage();

    const info = await screen.findByTestId('account-info');
    expect(getAccountMock).toHaveBeenCalledTimes(1);
    expect(within(info).getByTestId('account-name')).toHaveTextContent('张三');
    expect(within(info).getByTestId('account-phone')).toHaveTextContent('13800000000');
    // 只读的硬钉子：这张卡里不许有任何 input/textarea/select
    expect(info.querySelectorAll('input, textarea, select')).toHaveLength(0);

    // 改密码三段
    expect(screen.getByTestId('old-password-input')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('new-password-input')).toHaveAttribute('type', 'password');
    expect(screen.getByTestId('confirm-password-input')).toHaveAttribute('type', 'password');

    // 退出登录复用基座 LogoutButton（aria-label 是它的对外契约）
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument();
  });

  it('姓名缺失时显示「未设置」，不显示空串', async () => {
    getAccountMock.mockResolvedValueOnce({ ...ACCOUNT, name: null });

    renderPage();

    expect(await screen.findByTestId('account-name')).toHaveTextContent('未设置');
  });

  it('加载失败 → 错误卡 + 重试可恢复', async () => {
    getAccountMock.mockReset();
    getAccountMock.mockRejectedValueOnce(new Error('boom'));
    renderPage();

    await screen.findByTestId('account-error');
    expect(screen.queryByTestId('account-password')).not.toBeInTheDocument();

    getAccountMock.mockResolvedValueOnce(ACCOUNT);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByTestId('account-phone')).toHaveTextContent('13800000000');
    expect(screen.queryByTestId('account-error')).not.toBeInTheDocument();
  });
});

describe('ParentAccountPage：修改密码', () => {
  it('本地校验不过（旧密码空 / 新密码过短 / 过长 / 两次不一致）→ 不发请求', async () => {
    renderPage();
    await screen.findByTestId('account-password');

    const cases: Array<[string, string, string, string]> = [
      ['', 'newpass1', 'newpass1', '请输入旧密码'],
      ['oldpass1', '12345', '12345', '新密码需为 6-32 位'],
      ['oldpass1', 'x'.repeat(33), 'x'.repeat(33), '新密码需为 6-32 位'],
      ['oldpass1', 'newpass1', 'newpass2', '两次输入的新密码不一致'],
    ];

    for (const [old, next, confirm, message] of cases) {
      fillPasswords(old, next, confirm);
      fireEvent.click(screen.getByTestId('submit-password'));

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(changePasswordMock).not.toHaveBeenCalled();
    }
  });

  it('成功 → toast「密码已修改」+ 清空三个输入框', async () => {
    renderPage();
    await screen.findByTestId('account-password');

    fillPasswords('oldpass1', 'newpass1', 'newpass1');
    fireEvent.click(screen.getByTestId('submit-password'));

    await waitFor(() =>
      expect(changePasswordMock).toHaveBeenCalledWith('oldpass1', 'newpass1'),
    );
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('success', '密码已修改'));
    expect(screen.getByTestId('old-password-input')).toHaveValue('');
    expect(screen.getByTestId('new-password-input')).toHaveValue('');
    expect(screen.getByTestId('confirm-password-input')).toHaveValue('');
  });

  it('1003（旧密码错）→ toast + 错误标在**旧密码框**上，输入值保留', async () => {
    renderPage();
    await screen.findByTestId('account-password');

    changePasswordMock.mockRejectedValueOnce(new ApiError(1003, '旧密码错误'));
    fillPasswords('wrongpass', 'newpass1', 'newpass1');
    fireEvent.click(screen.getByTestId('submit-password'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '旧密码错误'));
    // 错误文案挂在旧密码框那一格（`Input` 的 error prop），另外两格不受牵连
    expect(within(fieldWrapper('old-password-input')).getByText('旧密码错误')).toBeInTheDocument();
    expect(
      within(fieldWrapper('new-password-input')).queryByText('旧密码错误'),
    ).not.toBeInTheDocument();
    expect(
      within(fieldWrapper('confirm-password-input')).queryByText('旧密码错误'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('old-password-input')).toHaveValue('wrongpass');
  });

  it('1001（长度/新旧相同）→ 只给 toast，不给任何一格标错', async () => {
    renderPage();
    await screen.findByTestId('account-password');

    changePasswordMock.mockRejectedValueOnce(new ApiError(1001, '新密码不能与旧密码相同'));
    fillPasswords('samepass1', 'samepass1', 'samepass1');
    fireEvent.click(screen.getByTestId('submit-password'));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('error', '新密码不能与旧密码相同'),
    );
    for (const id of ['old-password-input', 'new-password-input', 'confirm-password-input']) {
      expect(
        within(fieldWrapper(id)).queryByText('新密码不能与旧密码相同'),
      ).not.toBeInTheDocument();
    }
  });
});
