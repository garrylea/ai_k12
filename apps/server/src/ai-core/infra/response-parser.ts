import { z } from 'zod';
import type { ParseRequest, ParseResult, ParseMode } from '../types.js';

export class ResponseParser {
  /**
   * Task 14a: Extract a ```json fenced block from text. Returns parsed JSON
   * or null if no valid block is found. Used by TutoringCapability to pull
   * the structured question output from the model's Socratic reply.
   */
  extractJsonBlock(text: string): unknown | null {
    const match = text.match(/```json\s*([\s\S]*?)```/);
    if (!match) return null;
    try { return JSON.parse(match[1].trim()); } catch { return null; }
  }

  /**
   * Task 14a: Strip the ```json fenced block from text so the user doesn't
   * see raw JSON in the displayed reply or persisted conversation history.
   */
  stripJsonBlock(text: string): string {
    return text.replace(/```json\s*[\s\S]*?```\s*/g, '').trim();
  }

  parse<T = unknown>(request: ParseRequest): ParseResult<T> {
    switch (request.mode) {
      case 'text':
        return { success: true, data: null, rawText: request.rawContent };
      case 'latex':
        return { success: true, data: this.normalizeLatex(request.rawContent) as T, rawText: request.rawContent };
      case 'json':
        return this.parseJson<T>(request.rawContent, request.schema, request.defaultResult as T | undefined);
      case 'hybrid':
        return this.parseHybrid<T>(request.rawContent, request.schema);
      default:
        return { success: false, data: null, errors: [`Unknown parse mode: ${request.mode}`] };
    }
  }

  private parseJson<T>(raw: string, schema?: object, defaultResult?: T): ParseResult<T> {
    // Strip UTF-8 BOM and leading whitespace - JSON.parse rejects BOM-prefixed input.
    const sanitized = raw.replace(/^﻿/, '').trimStart();
    let data: unknown = undefined;
    const errors: string[] = [];

    // 1. Direct parse
    try { data = JSON.parse(sanitized); } catch { /* continue */ }

    // 2. Extract from code block
    if (data === undefined) {
      const match = sanitized.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      if (match) {
        try { data = JSON.parse(match[1]); } catch { /* continue */ }
      }
    }

    // 3. Repair common errors
    if (data === undefined) {
      const repaired = this.repairJson(sanitized);
      if (repaired) {
        try { data = JSON.parse(repaired); } catch { /* continue */ }
      }
    }

    // 4. Schema validation
    if (data !== undefined && schema) {
      try {
        const zodSchema = schema as z.ZodType;
        data = zodSchema.parse(data);
      } catch (e) {
        if (e instanceof z.ZodError) {
          errors.push(...e.errors.map(err => `${err.path.join('.')}: ${err.message}`));
          return { success: false, data: defaultResult ?? null, errors };
        }
      }
    }

    if (data !== undefined) {
      return { success: true, data: data as T };
    }

    return { success: false, data: defaultResult ?? null, errors: ['All JSON parsing attempts failed'] };
  }

  private repairJson(raw: string): string | null {
    let repaired = raw.trim();

    // Remove trailing commas before } or ]
    repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

    // Fix single quotes to double quotes (simple heuristic)
    repaired = repaired.replace(/'([^']*)'/g, (match) => {
      return '"' + match.slice(1, -1).replace(/"/g, '\\"') + '"';
    });

    if (repaired !== raw) return repaired;
    return null;
  }

  private normalizeLatex(text: string): string {
    let result = text.replace(/\\\((.*?)\\\)/g, '$$$1$$');
    result = result.replace(/\\\[(.*?)\\\]/gs, '$$$$\n$1\n$$$$');
    return result;
  }

  private parseHybrid<T>(raw: string, schema?: object): ParseResult<T> {
    const jsonMatch = raw.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      return this.parseJson<T>(jsonMatch[1], schema);
    }
    return { success: false, data: null, errors: ['No JSON block found in hybrid content'] };
  }
}
