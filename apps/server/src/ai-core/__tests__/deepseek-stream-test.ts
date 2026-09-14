// deepseek-stream-test.ts - 验证 deepseek 真实调用是否走流式 + reasoning 透传
// 注入 spy provider 记录 streamChat/chat 调用次数,确认走流式; 打印 reasoningContent 确认透传
import { ModelClient } from '../infra/model-client/index.js';
import { getModelConfig, getApiKeyByProvider, timeoutConfig } from '../config.js';
import { DeepSeekClient } from '../infra/model-client/deepseek-client.js';
import type { ProviderAdapter } from '../infra/model-client/types.js';

async function main() {
  const model = getModelConfig('deepseek-flash');
  console.log('baseurl:', model.baseUrl, '| model:', model.modelId, '| provider:', model.provider);

  const real = new DeepSeekClient(getApiKeyByProvider('deepseek'));
  let streamCalls = 0;
  let chatCalls = 0;
  const spy: ProviderAdapter = {
    chat: async (req) => { chatCalls++; return real.chat(req); },
    streamChat: async function* (req) { streamCalls++; yield* real.streamChat(req); },
  };

  const client = new ModelClient({
    retryOptions: timeoutConfig.retry,
    providers: new Map([['deepseek', spy]]),
  });

  const start = Date.now();
  const res = await client.chat({
    model,
    messages: [{ role: 'user', content: '解方程 2x+3=7，简短回答并说明思路' }],
    timeout: 60000,
  });

  console.log('\n=== 流式验证 ===');
  console.log('streamChat 调用次数:', streamCalls, '| chat(非流式) 调用次数:', chatCalls);
  console.log(streamCalls > 0 && chatCalls === 0 ? '✓ 采用流式返回(streamChat)' : '✗ 未走流式');

  console.log('\n=== ChatResponse ===');
  console.log('content:', res.content.slice(0, 200));
  console.log('reasoningContent:', res.reasoningContent ? res.reasoningContent.slice(0, 200) + '...' : '(none)');
  console.log('finishReason:', res.finishReason, '| latencyMs:', Date.now() - start);
  console.log('reasoning 已透传到 ChatResponse?', res.reasoningContent ? '✓ 是' : '✗ 否');
}

main();
