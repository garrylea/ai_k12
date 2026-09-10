// apps/web/src/components/business/answer/types.ts
// QuestionRunner 的对外类型（计划 2/3 的考试/专项/错题页消费）。

/** 答题组件的题目输入。n 为展示题号（考试用 question_no，错题用 questionN）。 */
export interface RunnerQuestion {
  n: string;
  /** 题面（Markdown+LaTeX） */
  text: string;
  /** 'choice' | 'true_false' | 'fill_blank' | 'short_answer' | 'proof' | 'calculation' */
  type?: string;
  /** 选择题选项；true_false 可缺省，缺省时组件渲染 对/错 两个选项 */
  options?: Array<{ label: string; text: string }>;
}

/** 单题作答记录：onFinish 快照交给父层，由父层决定后续（结果页/错题本等）。 */
export interface RunnerAnswerRecord {
  isCorrect: boolean;
  method: string;
  errorType?: string | null;
  studentAnswer: string;
  /** 判题请求失败（网络/服务端错误），区别于答错 */
  failed?: boolean;
}

/** onSubmit 的最小返回契约（JudgeResult 的结构子集；method 宽化为 string 以兼容旧 AnswerModal 回调签名）。 */
export interface RunnerJudgeOutcome {
  isCorrect: boolean | null;
  method: string;
  errorType?: string | null;
  /** 主观题 self_assess 模式：true 时 Runner 进入自评视图（同步等待，不 fire-and-forget） */
  needsSelfAssessment?: boolean;
  referenceAnswer?: string | null;
  explanation?: string | null;
  noStandardAnswer?: boolean;
  /** 判题结果对应的题目 id（self_assess 即时返回时回传，自评落库用） */
  questionId?: number | null;
}

/** 自评提交上下文：Runner 把判题返回的 questionId 与学生作答文本回传给父层落库。 */
export interface RunnerSelfAssessContext {
  questionId: number | null;
  studentAnswer: string;
}
