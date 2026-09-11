import { OpenAICompatibleClient } from './openai-compatible-client.js';

// Kimi (Moonshot) exposes an OpenAI-compatible endpoint - reuse the shared client.
export class KimiClient extends OpenAICompatibleClient {
  constructor(apiKey: string, providerName = 'Kimi') {
    super(apiKey, providerName);
  }
}
