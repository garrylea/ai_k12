import { describe, it, expect } from 'vitest';
import { ResponseParser } from './response-parser.js';
import { z } from 'zod';

const GradingResultSchema = z.object({
  totalScore: z.number(),
  maxScore: z.number(),
  steps: z.array(z.object({
    stepNumber: z.number(),
    description: z.string(),
    score: z.number(),
    maxScore: z.number(),
    isCorrect: z.boolean(),
    comment: z.string(),
  })),
  feedback: z.string(),
  suggestions: z.array(z.string()),
});

describe('ResponseParser', () => {
  const parser = new ResponseParser();

  it('parses text mode (pass-through)', () => {
    const result = parser.parse({ rawContent: 'hello world', mode: 'text' });
    expect(result.success).toBe(true);
    expect(result.rawText).toBe('hello world');
  });

  it('parses valid JSON directly', () => {
    const result = parser.parse({
      rawContent: '{"totalScore": 8, "maxScore": 10, "steps": [], "feedback": "good", "suggestions": []}',
      mode: 'json',
      schema: GradingResultSchema,
    });
    expect(result.success).toBe(true);
    expect((result.data as any).totalScore).toBe(8);
  });

  it('extracts JSON from markdown code block', () => {
    const result = parser.parse({
      rawContent: 'Here is the result:\n```json\n{"totalScore": 8, "maxScore": 10, "steps": [], "feedback": "good", "suggestions": []}\n```',
      mode: 'json',
      schema: GradingResultSchema,
    });
    expect(result.success).toBe(true);
    expect((result.data as any).totalScore).toBe(8);
  });

  it('repairs trailing commas in JSON', () => {
    const result = parser.parse({
      rawContent: '{"totalScore": 8, "maxScore": 10, "steps": [], "feedback": "good", "suggestions": [],}',
      mode: 'json',
      schema: GradingResultSchema,
    });
    expect(result.success).toBe(true);
    expect((result.data as any).totalScore).toBe(8);
  });

  it('returns error for invalid JSON with schema mismatch', () => {
    const result = parser.parse({
      rawContent: '{"wrongField": 123}',
      mode: 'json',
      schema: GradingResultSchema,
    });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('returns defaultResult on parse failure', () => {
    const result = parser.parse({
      rawContent: 'not json at all {{{',
      mode: 'json',
      defaultResult: { fallback: true },
    });
    expect(result.success).toBe(false);
    expect(result.data).toEqual({ fallback: true });
  });
});
