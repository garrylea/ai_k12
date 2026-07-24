import { KimiClient } from './kimi-client.js';

// DeepSeek exposes an OpenAI-compatible endpoint - reuse the shared client.
export class DeepSeekClient extends KimiClient {
  constructor(apiKey: string) {
    super(apiKey, 'DeepSeek');
  }
}
