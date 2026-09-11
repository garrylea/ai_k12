import { OpenAICompatibleClient } from './openai-compatible-client.js';

// DeepSeek exposes an OpenAI-compatible endpoint - reuse the shared client.
export class DeepSeekClient extends OpenAICompatibleClient {
  constructor(apiKey: string) {
    super(apiKey, 'DeepSeek');
  }
}
