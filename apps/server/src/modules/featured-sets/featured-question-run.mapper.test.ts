import { describe, expect, it } from 'vitest';
import { toFeaturedRunQuestion } from './featured-question-run.mapper.js';

it('保留材料、小问、来源和试卷题号', () => {
  expect(toFeaturedRunQuestion({
    id: 7, subject_id: 4, content: '物理材料题', type: 'short_answer',
    options: JSON.stringify([{ label: 'A', text: '甲' }]),
    material_text: '材料', material_url: null, sub_no: 2,
    source: '某卷', question_no: 18,
  })).toEqual({
    questionId: 7, text: '物理材料题', type: 'short_answer',
    options: [{ label: 'A', text: '甲' }], materialText: '材料', materialUrl: null,
    subNo: 2, materialPosition: 'before', source: '某卷', questionNo: 18,
  });
});
