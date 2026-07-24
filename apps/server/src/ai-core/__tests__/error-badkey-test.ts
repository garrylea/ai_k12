// error-badkey-test.ts - 验证 baseurl 正确但 Key 错误的错误处理
// 期望: HTTP 401 -> classifyError(401) -> AuthenticationError(retryable=false),立即抛出不重试
import { ModelClient } from '../infra/model-client/index.js';
import { getModelConfig, timeoutConfig } from '../config.js';
import { LLMClientError, AuthenticationError, TimeoutError } from '../types.js';
import { DeepSeekClient } from '../infra/model-client/deepseek-client.js';

async function main() {
  const model = getModelConfig('deepseek-v4-flash'); // 真实 baseurl
  console.log('baseurl:', model.baseUrl, '(正确) | provider:', model.provider, '| key: sk-wrong-key-invalid (错误)');

  let retries = 0;
  const client = new ModelClient({
    retryOptions: {
      ...timeoutConfig.retry,
      onRetry: (err, attempt, delay) => {
        retries++;
        const name = err instanceof LLMClientError ? err.name : (err as Error)?.constructor?.name ?? 'Error';
        console.log(`  [onRetry ${attempt}] ${name} delay=${delay}ms`);
      },
    },
    // 注入用错误 key 的 DeepSeekClient(真实 baseurl,错误 key -> 401)
    providers: new Map([['deepseek', new DeepSeekClient('sk-wrong-key-invalid')]]),
  });

  const start = Date.now();
  try {
    const res = await client.chat({ model, messages: [{ role: 'user', content: 'ping' }], timeout: 10000 });
    console.log('意外成功:', res.content.slice(0, 50));
  } catch (e: any) {
    console.log(`\n耗时: ${Date.now() - start}ms`);
    console.log('错误类型:', e?.constructor?.name);
    console.log('  instanceof LLMClientError:', e instanceof LLMClientError);
    console.log('  instanceof AuthenticationError:', e instanceof AuthenticationError);
    console.log('  instanceof TimeoutError:', e instanceof TimeoutError);
    if (e instanceof LLMClientError) {
      console.log('  provider:', e.provider, '| statusCode:', e.statusCode, '| retryable:', e.retryable);
      console.log('  hint:', e.hint);
      console.log('  message:', e.message?.slice(0, 140));
    } else {
      console.log('  (raw, 未归一为 LLMClientError) message:', e?.message?.slice(0, 140));
    }
    console.log('onRetry 回调次数:', retries, '(期望 0 -- AuthenticationError 不可重试)');
  }
}

main();
