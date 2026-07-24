import { KimiClient } from './kimi-client.js';

// Qwen (DashScope) exposes an OpenAI-compatible endpoint - reuse the shared client.
export class QwenClient extends KimiClient {
  constructor(apiKey: string) {
    super(apiKey, 'Qwen');
  }
}
