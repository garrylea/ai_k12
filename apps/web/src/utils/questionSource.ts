// 题库 questions.source 的展示口径。
// 绝大多数是试卷名（如「北京市西城区九年级模拟测试试卷」），原样展示；
// 少数是入库渠道的机器串（auxiliary/freeform/practice/remediation），
// 直接给学生看没有意义，换成能读懂的来源标签，仍可用于溯源（2026-11-15）。
const SOURCE_LABELS: Record<string, string> = {
  auxiliary: '专项补充题',
  freeform: '答疑录入',
  practice: '练习录入',
  remediation: '补偿练习',
};

export function formatQuestionSource(source: string | null | undefined): string | null {
  if (!source) return null;
  return SOURCE_LABELS[source] ?? source;
}

/**
 * 卷内题号展示串（paper_questions.question_no）。
 * 专项练习的题从各份试卷里抽出来，作答页的「第 i/n 题」是本次练习的位次，
 * 与卷内题号不是一回事，所以带「试卷」二字区分（2026-11-16 用户要求）。
 */
export function formatPaperQuestionNo(
  questionNo: number | null | undefined,
  subNo?: number | null,
): string | null {
  if (questionNo == null) return null;
  return subNo ? `试卷第 ${questionNo} 题(${subNo})` : `试卷第 ${questionNo} 题`;
}
