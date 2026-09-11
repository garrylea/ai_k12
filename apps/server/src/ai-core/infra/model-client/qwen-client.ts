import { OpenAICompatibleClient } from './openai-compatible-client.js';

// Qwen (DashScope) exposes an OpenAI-compatible endpoint - reuse the shared client.
export class QwenClient extends OpenAICompatibleClient {
  constructor(apiKey: string) {
    super(apiKey, 'Qwen');
  }
}
