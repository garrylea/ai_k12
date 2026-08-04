import { describe, it, expect } from 'vitest';
import { ResponseParser } from './response-parser.js';

describe('ResponseParser.extractJsonBlock (Task 14a)', () => {
  const parser = new ResponseParser();

  it('extracts a ```json fenced block from text', () => {
    const text = '你观察一下等式两边。\n```json\n{"type":"short_answer","difficulty":1,"content":"1+1=?","answer":"2","explanation":"basic","knowledgePoints":["加法"],"quality":"good"}\n```';
    const result = parser.extractJsonBlock(text);
    expect(result).not.toBeNull();
    expect((result as any).type).toBe('short_answer');
    expect((result as any).content).toBe('1+1=?');
  });

  it('returns null when no json block is present', () => {
    const result = parser.extractJsonBlock('just a normal reply with no JSON');
    expect(result).toBeNull();
  });

  it('returns null when json block is invalid', () => {
    const result = parser.extractJsonBlock('```json\n{invalid json}\n```');
    expect(result).toBeNull();
  });

  it('handles json block with extra whitespace', () => {
    const text = 'reply\n\n```json\n  {"type":"proof","difficulty":3,"content":"prove","answer":"QED","explanation":"...","knowledgePoints":[],"quality":"good"}  \n```\n';
    const result = parser.extractJsonBlock(text);
    expect(result).not.toBeNull();
    expect((result as any).type).toBe('proof');
  });
});

describe('ResponseParser.stripJsonBlock (Task 14a)', () => {
  const parser = new ResponseParser();

  it('strips the json block from text, keeping the Socratic reply', () => {
    const text = '你观察一下等式两边。\n```json\n{"type":"short_answer","difficulty":1}\n```';
    const result = parser.stripJsonBlock(text);
    expect(result).toBe('你观察一下等式两边。');
  });

  it('leaves text unchanged when no json block is present', () => {
    const text = 'just a normal reply';
    expect(parser.stripJsonBlock(text)).toBe('just a normal reply');
  });

  it('strips multiple json blocks', () => {
    const text = 'reply1\n```json\n{"a":1}\n```\nreply2\n```json\n{"b":2}\n```';
    const result = parser.stripJsonBlock(text);
    expect(result).toBe('reply1\nreply2');
  });
});
