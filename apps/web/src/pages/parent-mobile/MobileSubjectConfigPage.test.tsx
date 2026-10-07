import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import MobileSubjectConfigPage from './MobileSubjectConfigPage';

afterEach(cleanup);

vi.mock('@/services/api', () => ({
  getStudentSubjectConfigs: vi.fn(),
  updateStudentSubjectConfig: vi.fn(),
}));
// toast 全仓测试统一 mock 成 vi.fn 断言（真 toast 需挂 ToastContainer 才渲染，页内断言不到文本）
vi.mock('@/components/base', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/base')>()),
  toast: vi.fn(),
}));
import { toast } from '@/components/base';
import { getStudentSubjectConfigs, updateStudentSubjectConfig } from '@/services/api';

const resp = {
  studentId: 7,
  studentName: 'lc1',
  subjects: [
    { subjectId: 2, subjectName: '数学', configured: true, started: true, gradeCode: 'G7', term: 'first', textbookVersionId: 10, publisher: '人教社', edition: '' },
  ],
  options: [
    { subjectId: 2, subjectName: '数学', grades: [
      { code: 'G7', label: '初一', versions: [{ id: 10, name: '人教版', publisher: '人教社', edition: '', gradeBand: 'junior', terms: ['first', 'second'] }] },
      { code: 'G8', label: '初二', versions: [{ id: 11, name: '北师大版', publisher: '北师大社', edition: '', gradeBand: 'junior', terms: ['first', 'second'] }] },
    ] },
  ],
};

function renderAtId(id = '7') {
  render(
    <MemoryRouter initialEntries={[`/m/parent/students/${id}/config`]}>
      <Routes>
        <Route path="/m/parent/students/:id/config" element={<MobileSubjectConfigPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MobileSubjectConfigPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染各学科当前配置（按路径 id 取数，不读切换器锚点）', async () => {
    vi.mocked(getStudentSubjectConfigs).mockResolvedValue(resp as never);
    renderAtId('7');
    expect(await screen.findByText('数学')).toBeTruthy();
    expect(screen.getByText(/人教版/)).toBeTruthy();
    expect(getStudentSubjectConfigs).toHaveBeenCalledWith(7);
  });

  it('改年级后保存：确认弹窗 + reset 提示 + 重拉', async () => {
    vi.mocked(getStudentSubjectConfigs).mockResolvedValue(resp as never);
    vi.mocked(updateStudentSubjectConfig).mockResolvedValue({ subjectId: 2, textbookVersionId: 11, semesterId: 5, reset: true });
    renderAtId('7');
    await screen.findByText('数学');
    // 改年级 → 初二（联动切版本 11、册别 first）
    await userEvent.selectOptions(screen.getByLabelText('数学-年级'), 'G8');
    await userEvent.click(screen.getByTestId('config-save-2'));
    // 确认弹窗（ConfirmDialog 确认按钮 aria-label="确认"）
    await userEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() =>
      expect(updateStudentSubjectConfig).toHaveBeenCalledWith(7, 2, { gradeCode: 'G8', term: 'first', textbookVersionId: 11 }),
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('success', '已切换 数学 教材，该学科学习进度已重置'),
    );
    await waitFor(() => expect(getStudentSubjectConfigs).toHaveBeenCalledTimes(2));
  });

  it('无改动不显示保存按钮', async () => {
    vi.mocked(getStudentSubjectConfigs).mockResolvedValue(resp as never);
    renderAtId('7');
    await screen.findByText('数学');
    expect(screen.queryByTestId('config-save-2')).toBeNull();
  });

  it('加载失败显示错误重试', async () => {
    vi.mocked(getStudentSubjectConfigs).mockRejectedValue(new Error('x'));
    renderAtId('7');
    expect(await screen.findByTestId('config-retry')).toBeTruthy();
  });
});
