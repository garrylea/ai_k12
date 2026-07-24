import type { FallbackRequest, FallbackResponse } from '../types.js';
import { timeoutConfig } from '../config.js';

interface FallbackDeps {
  promptBuilder: { build: (req: any) => Promise<{ messages: any[]; estimatedTokens: number; templateVersion: string }> };
  modelClient: { chat: (req: any) => Promise<{ content: string }> };
  modelRouter: { route: (req: any) => { primary: { modelId: string }; reason: string } };
}

export class FallbackHandler {
  private promptBuilder: FallbackDeps['promptBuilder'];
  private modelClient: FallbackDeps['modelClient'];
  private modelRouter: FallbackDeps['modelRouter'];

  constructor(deps: FallbackDeps) {
    this.promptBuilder = deps.promptBuilder;
    this.modelClient = deps.modelClient;
    this.modelRouter = deps.modelRouter;
  }

  async handle(request: FallbackRequest): Promise<FallbackResponse> {
    const promptResult = await this.promptBuilder.build({
      capability: 'fallback',
      subject: request.knowledgePoint.subject,
      context: {
        student: { grade: '', gradeLevel: '' },
        knowledgePoint: request.knowledgePoint,
        question: request.question,
        dialogueHistory: request.dialogueHistory,
        userMessage: '我需要完整的解析',
      },
    });

    const routeResult = this.modelRouter.route({
      scene: 'explanation',
      subject: request.knowledgePoint.subject,
    });

    const chatResponse = await this.modelClient.chat({
      model: routeResult.primary,
      messages: promptResult.messages,
      timeout: timeoutConfig.timeout.explanation ?? timeoutConfig.timeout.default,
    });

    return {
      type: 'fallback',
      content: chatResponse.content,
      includesCompleteAnswer: true,
      summary: this.extractSummary(chatResponse.content),
      recommendations: this.extractRecommendations(chatResponse.content),
    };
  }

  private extractSummary(content: string): string {
    const match = content.match(/知识点总结[：:]*\s*\n([\s\S]*?)(?=\n#|$)/);
    return match ? match[1].trim() : content.slice(0, 200);
  }

  private extractRecommendations(content: string): string[] {
    const match = content.match(/建议[：:]*\s*\n([\s\S]*?)$/);
    if (!match) return [];
    return match[1]
      .split('\n')
      .filter(line => line.trim().startsWith('-') || line.trim().match(/^\d+\./))
      .map(line => line.replace(/^[-\d.]+\s*/, '').trim())
      .filter(Boolean);
  }
}
