/**
 * 流式调用的 token 估算兜底。
 *
 * 为什么需要：`ModelClient.chat()` 默认走流式（model-client/index.ts:64），而多数
 * OpenAI 兼容端点的流式响应默认**不带 usage**（Kimi 明确不带，见同文件 :79 的注释）。
 * 不估算的话 token 恒为 0、成本恒为 0，成本面板全空。
 *
 * 口径（**唯一实现处**，改动只改这里）：
 *   - CJK 文字与全角标点：约 1 字 = 1 token
 *   - 其余（拉丁字母/数字/半角标点）：约 4 字符 = 1 token，向上取整
 * 这是**估算**，调用方必须把 usage_source 标成 'estimated' 让上层能区分。
 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, '');
  const latin = rest.replace(/\s/g, '').length;
  return cjk + Math.ceil(latin / 4);
}
