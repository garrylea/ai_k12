// error-baseurl-test.ts - 验证错误 baseurl 的错误处理(callWithRetry + classifyError)
// 用真实 deepseek key + 错误 baseurl,期望: 网络错误归一为 TimeoutError(retryable),重试 maxRetries 次后抛出
import { ModelClient } from '../infra/model-client/index.js';
import { getModelConfig, timeoutConfig } from '../config.js';
import { LLMClientError, TimeoutError, ServerError } from '../types.js';

async function main() {
  const base = getModelConfig('deepseek-flash');
  const model = { ...base, baseUrl: 'https://invalid-host.example.invalid' };
  console.log('baseurl:', model.baseUrl, '| provider:', model.provider);

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
  });

  const start = Date.now();
  try {
    const res = await client.chat({ model, messages: [{ role: 'user', content: 'ping' }], timeout: 3000 });
    console.log('意外成功:', res.content.slice(0, 50));
  } catch (e: any) {
    console.log(`\n耗时: ${Date.now() - start}ms`);
    console.log('错误类型:', e?.constructor?.name);
    console.log('  instanceof LLMClientError:', e instanceof LLMClientError);
    console.log('  instanceof TimeoutError:', e instanceof TimeoutError);
    console.log('  instanceof ServerError:', e instanceof ServerError);
    if (e instanceof LLMClientError) {
      console.log('  provider:', e.provider, '| statusCode:', e.statusCode, '| retryable:', e.retryable);
      console.log('  hint:', e.hint);
      console.log('  message:', e.message?.slice(0, 120));
    } else {
      console.log('  (raw, 未归一为 LLMClientError) message:', e?.message?.slice(0, 120));
    }
    console.log('onRetry 回调次数:', retries, '| maxRetries:', timeoutConfig.retry.maxRetries);
  }
}

main();
