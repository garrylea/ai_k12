import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import MobileStudentsPage from './MobileStudentsPage';

afterEach(cleanup);

// mock spy 是模块级的，调用记录跨用例累积；不清会导致「尚未发请求」断言撞上前用例的调用
beforeEach(() => {
  vi.clearAllMocks();
});

vi.mock('@/services/api', () => ({
  listMyStudents: vi.fn(),
  createStudent: vi.fn(),
  resetStudentPassword: vi.fn(),
  setStudentStatus: vi.fn(),
}));
import { createStudent, listMyStudents, resetStudentPassword, setStudentStatus } from '@/services/api';

const students = [
  { id: 1, parentId: 9, username: 'stu1', name: '小明', age: 10, grade: '四年级', schoolLevel: 'primary', isActive: true },
];

// 行内有 <Link>（学习配置入口），必须包 Router 才能渲染
function renderPage() {
  render(
    <MemoryRouter>
      <MobileStudentsPage />
    </MemoryRouter>,
  );
}

describe('MobileStudentsPage', () => {
  it('渲染学生列表与状态', async () => {
    vi.mocked(listMyStudents).mockResolvedValue(students as never);
    renderPage();
    expect(await screen.findByText('小明')).toBeTruthy();
    expect(screen.getByText(/状态正常/)).toBeTruthy();
    expect(screen.getByTestId('student-create-toggle')).toBeTruthy();
  });

  it('新建学生：必填校验拦截 + 成功后刷新列表', async () => {
    // 初始只返回小明；createStudent 成功后 load() 重新拉取，第二次返回含新学生的列表（模拟服务端）
    vi.mocked(listMyStudents)
      .mockResolvedValueOnce(students as never)
      .mockResolvedValue([...students, { id: 2, parentId: 9, username: 'stu2', name: '小红', age: 8, grade: '小学二年级', schoolLevel: 'primary', isActive: true }] as never);
    vi.mocked(createStudent).mockResolvedValue({ id: 2 });
    renderPage();
    await screen.findByText('小明');
    await userEvent.click(screen.getByTestId('student-create-toggle'));
    // 空表单直接提交被拦
    await userEvent.click(screen.getByTestId('student-create-submit'));
    expect(createStudent).not.toHaveBeenCalled();
    // 填齐后提交
    await userEvent.type(screen.getByLabelText('姓名'), '小红');
    await userEvent.type(screen.getByLabelText('用户名'), 'stu2');
    await userEvent.type(screen.getByLabelText('初始密码'), 'pw123456');
    await userEvent.type(screen.getByLabelText('年龄'), '8');
    await userEvent.selectOptions(screen.getByLabelText('年级'), '小学二年级');
    await userEvent.click(screen.getByTestId('student-create-submit'));
    await waitFor(() => expect(createStudent).toHaveBeenCalledWith({ name: '小红', username: 'stu2', password: 'pw123456', age: 8, grade: '小学二年级' }));
    expect(await screen.findByText('小红')).toBeTruthy();
  });

  it('createStudent 失败（用户名冲突 1004）原样展示错误', async () => {
    vi.mocked(listMyStudents).mockResolvedValue(students as never);
    vi.mocked(createStudent).mockRejectedValue(new Error('用户名已存在'));
    renderPage();
    await screen.findByText('小明');
    await userEvent.click(screen.getByTestId('student-create-toggle'));
    await userEvent.type(screen.getByLabelText('姓名'), '小红');
    await userEvent.type(screen.getByLabelText('用户名'), 'stu1');
    await userEvent.type(screen.getByLabelText('初始密码'), 'pw123456');
    await userEvent.type(screen.getByLabelText('年龄'), '8');
    await userEvent.selectOptions(screen.getByLabelText('年级'), '小学二年级');
    await userEvent.click(screen.getByTestId('student-create-submit'));
    expect(await screen.findByText(/用户名已存在/)).toBeTruthy();
  });

  it('重置密码：新密码 6-32 位 + 成功提示', async () => {
    vi.mocked(listMyStudents).mockResolvedValue(students as never);
    vi.mocked(resetStudentPassword).mockResolvedValue(null);
    renderPage();
    await screen.findByText('小明');
    await userEvent.click(screen.getByTestId('student-reset-toggle-1'));
    const input = screen.getByPlaceholderText('输入新密码（6-32 位）');
    await userEvent.type(input, '123');
    await userEvent.click(screen.getByTestId('student-reset-submit-1'));
    expect(resetStudentPassword).not.toHaveBeenCalled();
    await userEvent.type(input, '456');
    await userEvent.click(screen.getByTestId('student-reset-submit-1'));
    await waitFor(() => expect(resetStudentPassword).toHaveBeenCalledWith(1, '123456'));
    expect(await screen.findByText(/已重置 小明 的密码/)).toBeTruthy();
  });

  it('停用/启用切换', async () => {
    vi.mocked(listMyStudents).mockResolvedValue(students as never);
    vi.mocked(setStudentStatus).mockResolvedValue(null);
    renderPage();
    await screen.findByText('小明');
    await userEvent.click(screen.getByTestId('student-status-toggle-1'));
    // 停用需经确认弹窗（spec §4.2）
    await userEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(setStudentStatus).toHaveBeenCalledWith(1, false));
    expect(await screen.findByText('已停用')).toBeTruthy();
  });

  it('每个学生行有到学习配置页的链接', async () => {
    vi.mocked(listMyStudents).mockResolvedValue(students as never);
    renderPage();
    await screen.findByText('小明');
    const link = screen.getByText('学习配置');
    expect(link.getAttribute('href')).toBe('/m/parent/students/1/config');
  });

  it('停用需确认弹窗：确认后才调 setStudentStatus(1, false)', async () => {
    vi.mocked(listMyStudents).mockResolvedValue(students as never);
    vi.mocked(setStudentStatus).mockResolvedValue(null);
    renderPage();
    await screen.findByText('小明');
    await userEvent.click(screen.getByTestId('student-status-toggle-1'));
    // 弹窗出现，但尚未发请求
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(setStudentStatus).not.toHaveBeenCalled();
    // ConfirmDialog 确认按钮 aria-label="确认"
    await userEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(setStudentStatus).toHaveBeenCalledWith(1, false));
  });

  it('启用不弹确认，直接调 setStudentStatus(1, true)', async () => {
    vi.mocked(listMyStudents).mockResolvedValue([
      { ...students[0], isActive: false },
    ] as never);
    vi.mocked(setStudentStatus).mockResolvedValue(null);
    renderPage();
    await screen.findByText('小明');
    await userEvent.click(screen.getByTestId('student-status-toggle-1'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(setStudentStatus).toHaveBeenCalledWith(1, true));
  });
});
