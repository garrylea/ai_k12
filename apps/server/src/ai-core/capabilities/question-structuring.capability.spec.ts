import { describe, it, expect } from 'vitest';
import { QuestionStructuringCapability } from './question-structuring.capability.js';

class FakeModelClient {
  async chat() {
    return {
      content: JSON.stringify({
        type: 'choice',
        difficulty: 2,
        content: '1+1=?',
        options: [
          { label: 'A', text: '1', isCorrect: false },
          { label: 'B', text: '2', isCorrect: true },
        ],
        answer: 'B',
        explanation: 'basic addition',
        knowledgePoints: ['整数加法'],
        quality: 'good',
        qualityIssues: [],
      }),
      reasoningContent: '',
    };
  }
}

describe('QuestionStructuringCapability', () => {
  it('structures a question from raw text input', async () => {
    const cap = new QuestionStructuringCapability({ modelClient: new FakeModelClient() as any });
    const result = await cap.structure({
      rawInput: '1+1=?',
      inputType: 'text',
      studentId: 's1',
      subjectHint: 'math',
    });
    expect(result.type).toBe('choice');
    expect(result.answer).toBe('B');
    expect(result.quality).toBe('good');
    expect(result.knowledgePoints).toContain('整数加法');
  });

  it('returns default poor result when LLM returns invalid JSON', async () => {
    class BadModelClient {
      async chat() { return { content: 'not json at all', reasoningContent: '' }; }
    }
    const cap = new QuestionStructuringCapability({ modelClient: new BadModelClient() as any });
    const result = await cap.structure({
      rawInput: 'garbage',
      inputType: 'text',
      studentId: 's1',
    });
    expect(result.quality).toBe('poor');
    expect(result.qualityIssues).toContain('JSON 解析失败');
  });

  it('handles image_markdown input type', async () => {
    const cap = new QuestionStructuringCapability({ modelClient: new FakeModelClient() as any });
    const result = await cap.structure({
      rawInput: '## 题目\n求解 2x=4',
      inputType: 'image_markdown',
      studentId: 's1',
      subjectHint: 'math',
      gradeBand: 'junior',
    });
    expect(result.type).toBe('choice');
  });

  it('passes rawInput and inputType through to the prompt template', async () => {
    let capturedMessages: any[] = [];
    class CapturingFakeClient {
      async chat(req: any) {
        capturedMessages = req.messages;
        return {
          content: JSON.stringify({
            type: 'short_answer', difficulty: 1, content: 'test', answer: 'a',
            explanation: 'e', knowledgePoints: [], quality: 'good', qualityIssues: [],
          }),
          reasoningContent: '',
        };
      }
    }
    const cap = new QuestionStructuringCapability({ modelClient: new CapturingFakeClient() as any });
    await cap.structure({
      rawInput: '求解 2x=4',
      inputType: 'text',
      studentId: 's1',
      subjectHint: 'math',
      gradeBand: 'junior',
    });
    // The user message (last message) should contain the rawInput and inputType
    const userMessage = capturedMessages[capturedMessages.length - 1].content;
    expect(userMessage).toContain('求解 2x=4');
    expect(userMessage).toContain('text');
  });

  it('returns default poor result when JSON fails schema validation', async () => {
    class SchemaFailClient {
      async chat() {
        return {
          content: JSON.stringify({
            type: 'invalid_type',   // not in enum
            difficulty: 5,           // not 1|2|3
            content: 'test',
            answer: 'a',
            explanation: 'e',
            knowledgePoints: [],
            quality: 'good',
          }),
          reasoningContent: '',
        };
      }
    }
    const cap = new QuestionStructuringCapability({ modelClient: new SchemaFailClient() as any });
    const result = await cap.structure({
      rawInput: 'test',
      inputType: 'text',
      studentId: 's1',
    });
    expect(result.quality).toBe('poor');
    expect(result.qualityIssues?.[0]).toBe('JSON 解析失败');
  });
});
