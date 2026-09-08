import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import Mustache from 'mustache';
import type { PromptBuildRequest, PromptBuildResult, ChatMessage, CapabilityType, Track, ExplanationMode, Message } from '../types.js';
import { contentToText } from '../types.js';

export class PromptBuilder {
  private templateCache = new Map<string, string>();
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async build(request: PromptBuildRequest): Promise<PromptBuildResult> {
    const templatePath = this.resolveTemplatePath(request.capability, request.subject, request.track, request.questionType, request.mode);
    const template = await this.loadTemplate(templatePath);

    // Extract frontmatter version
    const versionMatch = template.match(/^---\nversion:\s*"([^"]+)"[\s\S]*?---\n/);
    const templateVersion = versionMatch ? versionMatch[1] : 'unknown';
    const bodyOnly = template.replace(/^---[\s\S]*?---\n/, '');

    // Load and merge partials
    const partials = await this.loadPartials(bodyOnly);

    // Render with Mustache. Spread customVariables onto the view so template
    // references like {{maxScore}} resolve (they live under context.customVariables,
    // not as top-level context keys). Disable HTML escaping: these are LLM prompts
    // (plain text/markdown), not HTML, so characters like = < > & in math content
    // must be preserved verbatim (default Mustache would turn "x=3" into "x&#x3D;3").
    //
    // Task 14a: dialogueHistory messages may have array content (image_url parts).
    // Mustache would toString the array (wrong); coerce to text-only before rendering.
    const dialogueHistoryText: Message[] | undefined = request.context.dialogueHistory
      ? request.context.dialogueHistory.map(m => ({
          role: m.role,
          content: contentToText(m.content),
        }))
      : undefined;
    const view = {
      ...request.context,
      dialogueHistory: dialogueHistoryText,
      ...(request.context.customVariables ?? {}),
    };
    const rendered = Mustache.render(bodyOnly, view, partials, {
      escape: (value: unknown) => (value == null ? '' : String(value)),
    });

    // Build messages array. Pass dialogueHistory as-is (always text from DB)
    // for the LLM API. The text-coerced version above is only for Mustache rendering.
    const messages = this.buildMessages(rendered, request.context.dialogueHistory as ChatMessage[] | undefined);

    // Estimate tokens (rough: 1 token ≈ 2 chars for Chinese). Use text length
    // for array content (image parts don't count toward text token budget).
    const totalChars = messages.reduce((sum, m) => sum + contentToText(m.content).length, 0);
    const estimatedTokens = Math.ceil(totalChars / 2);

    return { messages, estimatedTokens, templateVersion };
  }

  private resolveTemplatePath(capability: CapabilityType, subject: string, track?: Track, questionType?: string, mode?: ExplanationMode): string {
    if (capability === 'tutoring') {
      return `tutoring/${subject}/${track ?? 'auxiliary'}.md`;
    }
    if (capability === 'grading') {
      if (questionType === 'proof') return `grading/math-proof.md`;
      if (questionType === 'calculation') return `grading/math-calculation.md`;
      return `grading/${subject}-reading.md`;
    }
    if (capability === 'judgment') {
      if (questionType === 'proof') return `judgment/math-proof.md`;
      if (questionType === 'calculation') return `judgment/math-calculation.md`;
      return `judgment/math-calculation.md`;
    }
    if (capability === 'explanation') {
      if (mode === 'knowledge_retry') return `explanation/knowledge-retry.md`;
      if (mode === 'solution') return `explanation/solution.md`;
      return `explanation/error-analysis.md`;
    }
    if (capability === 'hint') {
      return `hint/${subject}.md`;
    }
    if (capability === 'variation') {
      return `variation/generate.md`;
    }
    if (capability === 'analysis') {
      return `analytics/report.md`;
    }
    if (capability === 'fallback') {
      return `fallback/full-explanation.md`;
    }
    if (capability === 'structuring') {
      return `structuring/question.md`;
    }
    if (capability === 'transcribe') {
      return `transcribe/${subject}.md`;
    }
    throw new Error(`Unknown capability: ${capability}`);
  }

  private async loadTemplate(relativePath: string): Promise<string> {
    if (this.templateCache.has(relativePath)) {
      return this.templateCache.get(relativePath)!;
    }

    const fullPath = resolve(this.basePath, relativePath);
    if (!existsSync(fullPath)) {
      throw new Error(`Template not found: ${relativePath} (looked in ${fullPath})`);
    }

    const content = readFileSync(fullPath, 'utf-8');
    this.templateCache.set(relativePath, content);
    return content;
  }

  private async loadPartials(template: string): Promise<Record<string, string>> {
    const partials: Record<string, string> = {};
    const partialRefs = template.matchAll(/\{\{>\s*([\w-]+)\s*\}\}/g);

    for (const match of partialRefs) {
      const name = match[1];
      if (!partials[name]) {
        const partialPath = `system/${name}.md`;
        try {
          partials[name] = this.stripFrontmatter(await this.loadTemplate(partialPath));
        } catch {
          console.warn(`[PromptBuilder] Partial not found: ${partialPath}`);
        }
      }
    }

    return partials;
  }

  private stripFrontmatter(template: string): string {
    return template.replace(/^---[\s\S]*?---\n/, '');
  }

  private buildMessages(rendered: string, dialogueHistory?: ChatMessage[]): ChatMessage[] {
    const parts = rendered.split(/^##\s+/m);
    const systemSection = parts.find(p => p.startsWith('System Prompt'));
    const userSection = parts.find(p => p.startsWith('User Message'));

    const messages: ChatMessage[] = [];

    if (systemSection) {
      messages.push({
        role: 'system',
        content: systemSection.replace(/^System Prompt\s*\n?/, '').trim(),
      });
    }

    if (dialogueHistory && dialogueHistory.length > 0) {
      messages.push(...dialogueHistory);
    }

    if (userSection) {
      messages.push({
        role: 'user',
        content: userSection.replace(/^User Message\s*\n?/, '').trim(),
      });
    } else {
      messages.push({
        role: 'user',
        content: rendered.trim(),
      });
    }

    return messages;
  }
}
