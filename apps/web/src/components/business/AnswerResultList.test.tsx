// 学生答案里的手绘图在结果页必须能看清（默认题面小图样式会压成 50px 细条）。
// 注意：本组件还会渲染题面/解析等多处 Markdown —— 用例里只放一张图（在学生答案里），
// 也不展开「查看解析」，否则 getByRole('img') 会命中多个。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnswerResultList } from './AnswerResultList';

afterEach(() => cleanup());

describe('AnswerResultList 学生答案图片', () => {
  it('学生答案含图片：结果页按作答大图样式渲染', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '电路图题' }]}
        answers={{ '1': { isCorrect: false, method: 'self_assess', studentAnswer: '2. ![图1](/uploads/a/b.png)' } }}
        onClose={() => {}}
      />,
    );
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toBe('/uploads/a/b.png');
    expect(img.className).toContain('max-h-[40vh]');
    expect(img.className).not.toContain('h-[50px]');
  });

  it('题面图片仍按题面小图样式渲染（只改学生答案这一处）', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '![题面图](/uploads/t/t.png)' }]}
        answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
      />,
    );
    const img = screen.getByRole('img');
    expect(img.className).toContain('h-[50px]');
    expect(img.className).not.toContain('max-h-[40vh]');
  });
});

describe('AnswerResultList 材料排版', () => {
  it('材料块挂 md-prose，Markdown 标题按标题渲染、单换行分成自然段', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题一', material: '## 发言稿三\n①第一段。\n②第二段。' }]}
        answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
      />,
    );
    const block = screen.getByTestId('result-material-text');
    expect(block.className).toContain('md-prose');
    expect(block.querySelector('h2')?.textContent).toBe('发言稿三');
    // 管线材料一行一段：单换行必须拆成两个 <p>，不能挤成一段
    const paragraphs = [...block.querySelectorAll('p')];
    expect(paragraphs.map((p) => p.textContent)).toEqual(['①第一段。', '②第二段。']);
  });
});

describe('AnswerResultList 题号', () => {
  it('结果列表不显示题号，但保留题干与状态', () => {
    render(
      <AnswerResultList
        questions={[{ n: '2', text: '题二' }]}
        answers={{ '2': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('result-qno-2')).toBeNull();
    expect(screen.getByText('题二')).toBeInTheDocument();
  });
});

describe('AnswerResultList 解析入口', () => {
  it('客观错题无解析：不显示查看解析、生成中或刷新', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: false, method: 'exact', studentAnswer: 'B' } }}
        initialExplanations={{}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: '查看解析' })).toBeNull();
    expect(screen.queryByText('正在生成中…')).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新解析' })).toBeNull();
  });

  it('客观错题有解析：显示查看解析', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: false, method: 'exact', studentAnswer: 'B' } }}
        initialExplanations={{ '1': '完整解析' }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '查看解析' })).toBeTruthy();
  });

  it('主观题无解析：不显示查看解析，但保留自评入口', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '证明题' }]}
        answers={{ '1': {
          isCorrect: true, method: 'self_assess', studentAnswer: '作答', needsSelfAssess: true,
        } }}
        initialExplanations={{}}
        referenceAnswers={{ '1': '参考答案' }}
        onClose={() => {}}
        onSelfAssess={async () => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: '查看解析' })).toBeNull();
    expect(screen.getByRole('button', { name: '查看参考答案' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '我做对了' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '我做错了' })).toBeInTheDocument();
  });

  it('主观题有解析：显示查看解析并可展开', async () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '证明题' }]}
        answers={{ '1': { isCorrect: true, method: 'self_assess', studentAnswer: '作答' } }}
        initialExplanations={{ '1': '完整解析' }}
        referenceAnswers={{ '1': '参考答案' }}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '查看解析' }));
    expect(screen.getByText('完整解析')).toBeInTheDocument();
  });

  it('展开解析时先显示思路、再显示详解，两段都按 Markdown 渲染', async () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: false, method: 'exact', studentAnswer: 'B' } }}
        initialExplanations={{ '1': '## 详解\n\n先代入，再 **检验**。' }}
        initialApproaches={{ '1': '## 思路\n\n先找 **等量关系**。' }}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: '查看解析' }));
    const approach = screen.getByTestId('result-approach-1');
    const explanation = screen.getByTestId('result-explanation-1');

    expect(within(approach).getByText('等量关系').tagName).toBe('STRONG');
    expect(within(explanation).getByText('检验').tagName).toBe('STRONG');
    expect(approach.compareDocumentPosition(explanation) & 4).toBe(4);
  });
});

describe('AnswerResultList 无参考答案（method=no_standard_answer）', () => {
  it('unscored 项显示「无参考答案 · 不计分」，无自评按钮，且不计入对/错/主观计数', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '客观题' }, { n: '2', text: '无答案题' }]}
        answers={{
          '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' },
          '2': { isCorrect: false, method: 'no_standard_answer', studentAnswer: '写了点东西', unscored: true },
        }}
        onClose={() => {}}
        onSelfAssess={async () => {}}
      />,
    );
    expect(screen.getByText('无参考答案 · 不计分')).toBeTruthy();
    // 顶部统计单列无参考答案题数
    expect(screen.getByText('无参考答案 1 题')).toBeTruthy();
    // 不计分：不渲染自评按钮，也不出「查看解析」的对错分支
    expect(screen.queryAllByRole('button', { name: /自评|做对|做错/ })).toHaveLength(0);
    // 计数：题面 2 道，只算 1 道答对，无错题/主观题
    expect(screen.getByText(/对\s*1/)).toBeTruthy();
    expect(screen.getByText(/错\s*0/)).toBeTruthy();
    expect(screen.queryByText(/主观\s*\d/)).toBeNull();
  });

  it('普通记录（不传 unscored）计数保持原样', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题一' }, { n: '2', text: '题二' }]}
        answers={{
          '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' },
          '2': { isCorrect: false, method: 'exact', studentAnswer: 'B' },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/无参考答案/)).toBeNull();
    expect(screen.getByText(/对\s*1/)).toBeTruthy();
    expect(screen.getByText(/错\s*1/)).toBeTruthy();
  });
});

describe('AnswerResultList 导出入口', () => {
  it('footerExtra 与导出、确认同处底部操作栏', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
        onExport={() => {}}
        footerExtra={<button type="button">扩展操作</button>}
      />,
    );
    const footer = screen.getByTestId('answer-result-footer');
    expect(within(footer).getByRole('button', { name: '扩展操作' })).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: '导出 PDF' })).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: '确认' })).toBeInTheDocument();
  });

  it('传 onExport 时出现「导出 PDF」并可点击', async () => {
    const onExport = vi.fn();
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
        onExport={onExport}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '导出 PDF' }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('不传 onExport 时不渲染「导出 PDF」', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: '导出 PDF' })).toBeNull();
  });
});
