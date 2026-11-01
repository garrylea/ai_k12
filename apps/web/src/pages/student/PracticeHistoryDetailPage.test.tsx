import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PracticeHistoryDetailPage from './PracticeHistoryDetailPage';
import { getPracticeHistoryDetail } from '@/services/api';

/**
 * 练习记录详情（2026-11-01）。
 * 契约：逐题回放（题面 + 我的答案 + 正确答案 + 解析 + 对错）；
 * 语文专项 questionId=null 时按 JSON 结构渲染；404 有回列表入口。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getPracticeHistoryDetail: vi.fn() };
});

const getDetailMock = vi.mocked(getPracticeHistoryDetail);

const EXAM_SESSION = {
  source: 'exam' as const,
  sessionId: 1,
  subjectId: 4,
  title: '北师大物理实验卷',
  module: null,
  startedAt: '2026-11-01T06:00:00.000Z',
  completedAt: '2026-11-01T06:40:00.000Z',
  totalCount: 2,
  correctCount: 1,
};

const SPECIAL_SESSION = {
  source: 'special' as const,
  sessionId: 5,
  subjectId: 2,
  title: '默写专项·静夜思',
  module: 'chinese_dictation',
  startedAt: '2026-10-31T11:30:00.000Z',
  completedAt: '2026-10-31T11:35:00.000Z',
  totalCount: 1,
  correctCount: 0,
};

function renderAt(source: string, sessionId: string) {
  return render(
    <MemoryRouter initialEntries={[`/student/practice-history/${source}/${sessionId}`]}>
      <Routes>
        <Route path="/student/practice-history/:source/:sessionId" element={<PracticeHistoryDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe('PracticeHistoryDetailPage', () => {
  it('加载中显示骨架', () => {
    getDetailMock.mockReturnValue(new Promise(() => {}));
    renderAt('exam', '1');
    expect(screen.getByTestId('history-detail-skeleton')).toBeInTheDocument();
  });

  it('考试详情：逐题渲染题面、我的答案、正确答案、对错', async () => {
    getDetailMock.mockResolvedValue({
      session: EXAM_SESSION,
      questions: [
        {
          questionId: 100, questionOrder: 1, answerText: 'B', isCorrect: false, score: 0,
          method: 'exact', analysis: '解析一', judgedAt: null,
          questionContent: '第1题题面', questionAnswer: 'C', questionAnalysis: null,
          refType: 'question', refId: null, sentenceIndex: null,
          passageTitle: null, passageSentence: null,
        },
        {
          questionId: 101, questionOrder: 2, answerText: 'A', isCorrect: true, score: 1,
          method: 'exact', analysis: null, judgedAt: null,
          questionContent: '第2题题面', questionAnswer: 'A', questionAnalysis: '题库解析二',
          refType: 'question', refId: null, sentenceIndex: null,
          passageTitle: null, passageSentence: null,
        },
      ],
    });
    renderAt('exam', '1');
    await waitFor(() => expect(screen.getByText('北师大物理实验卷')).toBeInTheDocument());
    expect(screen.getByText('第1题题面')).toBeInTheDocument();
    expect(screen.getByText('第2题题面')).toBeInTheDocument();
    expect(screen.getByText('答错')).toBeInTheDocument();
    // 「答对」同时出现在状态徽章与页头统计
    expect(screen.getAllByText('答对').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('C')).toBeInTheDocument(); // 正确答案
    expect(screen.getByText('解析一')).toBeInTheDocument();
    expect(screen.getByText('题库解析二')).toBeInTheDocument();
  });

  it('语文专项：questionId=null 时按 JSON 渲染作者/朝代/正文', async () => {
    getDetailMock.mockResolvedValue({
      session: SPECIAL_SESSION,
      questions: [
        {
          questionId: null, questionOrder: 1,
          answerText: '{"author":"李白","dynasty":"唐","body":"床前明月光"}',
          isCorrect: false, score: 0, method: 'exact', analysis: null, judgedAt: null,
          questionContent: null, questionAnswer: null, questionAnalysis: null,
          refType: 'passage', refId: 42, sentenceIndex: 0,
          passageTitle: '静夜思', passageSentence: '床前明月光，疑是地上霜。',
        },
      ],
    });
    renderAt('special', '5');
    await waitFor(() => expect(screen.getByText('默写专项·静夜思')).toBeInTheDocument());
    expect(screen.getByText('静夜思')).toBeInTheDocument(); // 篇名
    expect(screen.getByText('床前明月光，疑是地上霜。')).toBeInTheDocument(); // 句原文
    expect(screen.getByText('李白')).toBeInTheDocument(); // JSON 解析出 author
    expect(screen.getByText('唐')).toBeInTheDocument();
  });

  it('解析缺失时显示「解析未生成」', async () => {
    getDetailMock.mockResolvedValue({
      session: EXAM_SESSION,
      questions: [{
        questionId: 100, questionOrder: 1, answerText: 'B', isCorrect: null, score: null,
        method: 'failed', analysis: null, judgedAt: null,
        questionContent: '题面', questionAnswer: 'C', questionAnalysis: null,
        refType: 'question', refId: null, sentenceIndex: null,
        passageTitle: null, passageSentence: null,
      }],
    });
    renderAt('exam', '1');
    await waitFor(() => expect(screen.getByText('解析未生成')).toBeInTheDocument());
    expect(screen.getByText('未判定')).toBeInTheDocument();
  });

  it('source 非法显示不存在 + 返回入口', async () => {
    renderAt('xxx', '1');
    await waitFor(() => expect(screen.getByText(/这条练习记录不存在/)).toBeInTheDocument());
    expect(screen.getByText('返回练习记录')).toBeInTheDocument();
  });

  it('查不到（API reject）显示不存在', async () => {
    getDetailMock.mockRejectedValue(new Error('404'));
    renderAt('exam', '999');
    await waitFor(() => expect(screen.getByText(/这条练习记录不存在/)).toBeInTheDocument());
  });
});
