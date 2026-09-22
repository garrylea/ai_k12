/** 左输入区（LatexEditor textarea）→ 右预览区（LatexPreview）的滚动跟随通道。
 *  故意绕开 React 状态：textarea 滚动是 60fps 事件，进 state 会让 QuestionRunner
 *  整树重渲染（题干 ReactMarkdown 跟着重解析）。ratio 由 LatexEditor 写入，
 *  apply 由 LatexPreview 注册（内容防抖重渲染后按最新比例重定位），
 *  QuestionRunner 只负责把同一个 ref 传给两侧。两侧内容高度不同（LaTeX 源码 vs
 *  渲染结果），只能比例映射，无法像素级同步。 */
export interface PreviewScrollSync {
  /** 输入区当前滚动比例（0–1） */
  ratio: number;
  /** 预览区注册的比例重放函数（未挂载时为 undefined） */
  apply?: () => void;
}
