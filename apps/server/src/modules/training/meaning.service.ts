import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import {
  ChinesePassagesRepository, toSentences, toKeyTerms, toSentenceMeanings,
  type PassageSentence, type PassageSentenceMeaning,
} from '../../database/repositories/chinese-passages.repo.js';
import { ChineseMeaningJudgeCapability } from '../../ai-core/capabilities/chinese-meaning-judge.capability.js';
import { stripPinyinAnnotation } from '../../common/utils/normalize-chinese.util.js';
import type {
  MeaningPassageListItem, MeaningPassageItem, MeaningJudgeResult,
  MeaningTermJudgeItem, MeaningPartJudge,
} from './dto/meaning.dto.js';

/**
 * 语文古诗文「含义」专项服务（2026-09-17）。
 *
 * 独立子系统：不挂 `questions`、不进错题本、不参与主线清零门禁、
 * 不用「不再展示」/提示缓存/自评 —— 所以本服务**只注入篇目 repo 与判题能力**，
 * 不注入任何学生状态 repo。
 *
 * 与解释专项最关键的差别：**没有程序短路**。含义与情感是理解性作答，
 * 拿字符串归一化全等去判不成立，一律交给 LLM。唯一保留的程序判断是
 * 「空答案 → unanswered」（外加「该句有没有标准含义」）。
 */
@Injectable()
export class MeaningService {
  private readonly logger = new Logger(MeaningService.name);

  constructor(
    private readonly passageRepo: ChinesePassagesRepository,
    private readonly meaningJudge: ChineseMeaningJudgeCapability,
  ) {}

  /**
   * 取该篇的含义数组，**只有与 sentences 等长才可信**。
   *
   * `toSentences` 用 filter/push（丢掉 text 非字符串的项），`toSentenceMeanings` 用 map
   * （保位置），两者长度一旦不等，`meanings[i]` 描述的就是**另一句**——没有异常、没有日志，
   * 学生会拿别的句子的标准含义被判分。这不是假想：重跑 `interpretation_cli` 会重写
   * `sentences`（可能切成不同的句数）却不动 `sentence_meanings`，含义就留成了旧切分下的对齐。
   *
   * 长度不等时**整个按无含义数据处理**（返回空数组）：开练侧全句 `answerable:false`、
   * 判题侧走「该句无标准含义」的 400。**不做猜测、不做部分对齐**——宁可少判一句，
   * 也不能静默串句。
   */
  private meaningsOf(
    passageId: number,
    sentences: PassageSentence[],
    raw: unknown,
  ): Array<PassageSentenceMeaning | null> {
    const meanings = toSentenceMeanings(raw);
    if (meanings.length !== sentences.length) {
      this.logger.warn(
        `sentence_meanings 与 sentences 长度不一致，按无含义数据处理 `
        + `(passageId=${passageId}, meanings=${meanings.length}, sentences=${sentences.length})`,
      );
      return [];
    }
    return meanings;
  }

  /** 配置页篇目清单：只出篇名与册次。 */
  async listMeaningPassages(): Promise<{ passages: MeaningPassageListItem[] }> {
    const rows = await this.passageRepo.findVerifiedForMeaning();
    return {
      passages: rows.map((r) => ({ passageId: r.id, workTitle: r.work_title, semester: r.semester })),
    };
  }

  /**
   * 开练：整篇句子的 `text` 一次给全（顶部原文条要渲染完整一首诗），
   * 但 `answerable:false` 的句子只显示、不出题。
   *
   * 白名单序列化：`meaning` / `emotion` / `translation` / `full_translation` /
   * `author` / `dynasty` / `body` 一律不下发。
   */
  async startMeaning(input: {
    semester: string | null;
    passageIds: number[] | null;
    count: number;
  }): Promise<{ passages: MeaningPassageItem[] }> {
    const rows = input.passageIds && input.passageIds.length > 0
      ? await this.passageRepo.findVerifiedByIdsForMeaning(input.passageIds)
      : await this.passageRepo.findRandomVerifiedForMeaning(input.semester, input.count);

    const passages: MeaningPassageItem[] = [];
    for (const r of rows) {
      const sentences = toSentences(r.sentences);
      // 防御：抽题池已按内容就绪过滤，手工改库仍可能留下空句集——
      // 下发没有句子的篇目会让前端渲染出空白卡片。
      if (sentences.length === 0) continue;
      const meanings = this.meaningsOf(r.id, sentences, r.sentence_meanings);
      const terms = toKeyTerms(r.key_terms);
      const items = sentences.map((s, index) => ({
        index, // 真实句下标，判题回传用
        text: s.text,
        terms: terms
          .filter((t) => t.sentenceIndex === index)
          .map((t) => ({
            term: t.term,                         // 原样（带注音），展示用
            plain: stripPinyinAnnotation(t.term), // 去注音，前端高亮定位用
          })),
        answerable: meanings[index] != null,
      }));
      // 整篇没有任何可作答的句子 → 不下发（避免前端渲染空白卡）
      if (!items.some((i) => i.answerable)) continue;
      passages.push({
        passageId: r.id,
        workTitle: r.work_title,
        semester: r.semester,
        sentences: items,
      });
    }
    // 指定篇目路径可能勾选多于 count 个，兜底截断（与 startDictation 同规矩）
    return { passages: passages.slice(0, input.count) };
  }

  /**
   * 判题：**逐句**判（该句的字词 + 深层含义 + 作者情感打包成一次 LLM 调用），
   * **纯读**、不写任何学生状态。
   *
   * 与解释专项唯一的流程差别是**没有归一化全等短路**：含义/情感是理解性作答，
   * 学生答得与标准答案逐字相同也必须过 LLM（测试钉住了 `method` 不会是 `exact`）。
   */
  async judgeMeaning(input: {
    passageId: number;
    sentenceIndex: number;
    terms: Array<{ term: string; answer: string }>;
    meaning: string;
    emotion: string;
  }): Promise<MeaningJudgeResult> {
    const passage = await this.passageRepo.findById(input.passageId);
    if (!passage) {
      throw new NotFoundException(`含义篇目不存在：${input.passageId}`);
    }

    const sentences = toSentences(passage.sentences);
    const std = sentences[input.sentenceIndex];
    if (!std) {
      throw new BadRequestException(`sentenceIndex 越界：${input.sentenceIndex}`);
    }
    const meanings = this.meaningsOf(passage.id, sentences, passage.sentence_meanings);
    const stdMeaning = meanings[input.sentenceIndex];
    if (!stdMeaning) {
      throw new BadRequestException(`该句无标准含义：${input.sentenceIndex}`);
    }
    const stdTerms = toKeyTerms(passage.key_terms).filter((t) => t.sentenceIndex === input.sentenceIndex);

    // 学生答案配对：同名取最后一条，多传的 term 忽略（服务端只认该句「应有」的字词）
    const answerByTerm = new Map<string, string>();
    for (const t of input.terms) answerByTerm.set(t.term.trim(), t.answer);
    const answerOf = (term: string) => answerByTerm.get(term.trim()) ?? '';

    // ---- 1. 空答案短路（本专项唯一的程序判断） ----
    type TermSlot = MeaningTermJudgeItem & { pending: boolean };
    const slots: TermSlot[] = stdTerms.map((t) => {
      const stu = answerOf(t.term);
      if (stu.trim() === '') {
        return { term: t.term, correct: false, method: 'unanswered', standard: t.gloss, comment: null, pending: false };
      }
      // 先占位为 undetermined：LLM 补判成功会覆盖，漏项/失败就保持 undetermined
      return { term: t.term, correct: null, method: 'undetermined', standard: t.gloss, comment: null, pending: true };
    });

    const partOf = (student: string, standard: string): MeaningPartJudge & { pending: boolean } =>
      student.trim() === ''
        ? { correct: false, method: 'unanswered', standard, comment: null, pending: false }
        : { correct: null, method: 'undetermined', standard, comment: null, pending: true };

    const meaningSlot = partOf(input.meaning, stdMeaning.meaning);
    const emotionSlot = partOf(input.emotion, stdMeaning.emotion);

    // ---- 2. 待判项打包一次调用 ----
    const pendingTerms = slots.filter((s) => s.pending);
    if (pendingTerms.length > 0 || meaningSlot.pending || emotionSlot.pending) {
      try {
        const judged = await this.meaningJudge.generate({
          workTitle: passage.work_title,
          sentence: std.text,
          standardTranslation: std.translation,
          standardMeaning: stdMeaning.meaning,
          standardEmotion: stdMeaning.emotion,
          studentMeaning: meaningSlot.pending ? input.meaning : null,
          studentEmotion: emotionSlot.pending ? input.emotion : null,
          terms: pendingTerms.map((s) => ({ term: s.term, gloss: s.standard, answer: answerOf(s.term) })),
        });

        for (const s of pendingTerms) {
          const hit = judged.terms.find((r) => r.term.trim() === s.term.trim());
          if (hit) {
            s.correct = hit.correct;
            s.method = 'ai';
            s.comment = hit.comment ?? null;
          }
          // 漏项：保持 undetermined（correct: null）
        }
        const fillPart = (
          slot: MeaningPartJudge & { pending: boolean },
          hit: { correct: boolean; comment?: string | null } | null | undefined,
        ) => {
          if (!slot.pending || !hit) return;
          slot.correct = hit.correct;
          slot.method = 'ai';
          slot.comment = hit.comment ?? null;
        };
        fillPart(meaningSlot, judged.meaning);
        fillPart(emotionSlot, judged.emotion);
      } catch (err) {
        this.logger.warn(
          `meaningJudge.generate failed (passageId=${input.passageId}, sentenceIndex=${input.sentenceIndex}): ${err}`,
        );
        // 兜底：待判项全部保持 undetermined；短路判出的项不受影响，且不向调用方抛错
      }
    }

    const stripPending = <T extends { pending: boolean }>(s: T): Omit<T, 'pending'> => {
      const { pending: _pending, ...rest } = s;
      return rest;
    };

    const termsOut = slots.map(stripPending);
    const meaningOut = stripPending(meaningSlot);
    const emotionOut = stripPending(emotionSlot);

    return {
      passageId: passage.id,
      sentenceIndex: input.sentenceIndex,
      allCorrect:
        termsOut.every((t) => t.correct === true) &&
        meaningOut.correct === true &&
        emotionOut.correct === true,
      terms: termsOut,
      meaning: meaningOut,
      emotion: emotionOut,
    };
  }
}
