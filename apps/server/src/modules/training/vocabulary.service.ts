import { Injectable, BadRequestException, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EnglishWordsRepository, toMeanings, toRootAffixes } from '../../database/repositories/english-words.repo.js';
import type { EnglishWordRow, EnglishWordPoolRow } from '../../database/repositories/english-words.repo.js';
import { StudentWordProgressRepository } from '../../database/repositories/student-word-progress.repo.js';
import { TrainingSessionsRepository } from '../../database/repositories/training-sessions.repo.js';
import { SpecialPracticeLogsRepository } from '../../database/repositories/special-practice-logs.repo.js';
import type { SpecialPracticeVerdict } from '../../database/repositories/special-practice-logs.repo.js';
import { isCorrectOf } from '../../common/utils/special-practice.util.js';
import { EnglishWordJudgeCapability } from '../../ai-core/capabilities/english-word-judge.capability.js';
import type { EnglishWordJudgeMode } from '../../ai-core/types.js';
import {
  commonMeanings,
  diffWordChars,
  extendedSenseIndexes,
  isEnglishWordMatch,
  isGlossMatch,
  isUsablePhonetic,
  levelsForPool,
  primaryGloss,
  progressDelta,
  type EnglishLevel,
  type EnglishWordMeaning,
  type LevelPool,
  type VocabularyVerdict,
  type WordCharDiffOp,
} from '../../common/utils/normalize-english.util.js';
import type {
  VocabularyDirection,
  VocabularyJudgeInput,
  VocabularyJudgeResult,
  VocabularyOptionsResult,
  VocabularyOrder,
  VocabularyPoolOption,
  VocabularyPromptKind,
  VocabularyQuestionItem,
  VocabularyStandardMeaning,
  VocabularyStartInput,
  VocabularyStartResult,
  WordFamilyMember,
  WordFamilyResult,
} from './dto/vocabulary.dto.js';

/** 剂量范围。与前端预设（10/15/20）一致，服务端兜底校验。 */
export const VOCABULARY_MIN_COUNT = 10;
export const VOCABULARY_MAX_COUNT = 20;

const POOL_LABELS: Record<LevelPool, string> = {
  junior: '仅初中',
  senior: '仅高中',
  all: '初中 + 高中全部',
};

/** 词库范围档位的展示顺序（不依赖对象键顺序）。 */
const POOL_KEYS: readonly LevelPool[] = ['junior', 'senior', 'all'];

export interface VocabularyServiceDeps {
  /** 判题模型能力。测试注入 mock，不依赖 API Key。 */
  judge?: EnglishWordJudgeCapability;
  /** 时钟。默认 `new Date()`；测试注入固定时刻，「今日已背」用例才可复现。 */
  now?: () => Date;
  /** 随机源（抽题洗牌 + 普通模式选义项方向）。默认 Math.random；测试注入定值。 */
  random?: () => number;
}

/**
 * **依赖注入注记（踩过的坑，2026-09-16 实测）**：`deps` 必须显式 `@Optional()`。
 *
 * 本类带 `@Injectable()`（要注入两个仓储），于是 TS 会发出 `design:paramtypes` 元数据；
 * 而 `deps` 的类型是**接口**，接口在运行时不存在，元数据里被写成 `Object`。
 * Nest 把 `Object` 当成一个真 token 去容器里找，找不到就**启动直接失败**：
 *   `Nest can't resolve dependencies of the VocabularyService (…, ?)`
 * 加 `@Optional()` 后容器跳过它，生产走 `deps?.x ?? 默认值` 那套默认值。
 *
 * 对照：`ai-core/capabilities/*.capability.ts` 那些类**故意不写 `@Injectable()`**
 * （见 hint.capability.ts）——没有装饰器就不发 `design:paramtypes`，Nest 直接零参实例化，
 * 所以它们同样形态的 `deps?: XxxDeps` 一直没事。区别只在「有没有 `@Injectable()`」，
 * 不是「参数可选不可选」。想给那些能力类加 `@Injectable()` 的话，这个坑会立刻复现。
 */
/**
 * 英语背单词服务。
 *
 * **独立子系统**：不挂 `questions`、不进错题本、不参与主线清零门禁、不用「不再展示」/提示缓存/自评。
 * 作答单位是「词的一个义项」，标准答案是词条自带属性。
 *
 * 三条判题路由（全部收敛在 judge 里，纯函数口径见 normalize-english.util.ts）：
 *   1. 答案是英文单词的方向（中→英、看音标写单词）：纯程序比对 + 拼写变体表，**不调 LLM**
 *   2. 英→中 · 常见义：程序短路（与释义原子归一化相等）→ 未命中才调 LLM（二档）
 *   3. 英→中 · 熟词僻义：程序短路（与目标僻义义项相等）→ 未命中才调 LLM（三档，多一档 off_target）
 *
 * 四个出题方向（`en2cn` / `cn2en` / `ph2en` / `random`）见 buildQuestion：
 * 前三个是显式方向，`random` 逐题在**本词出得了的方向**里等概率掷。
 *
 * 设计见 docs/superpowers/specs/2026-09-16-english-vocabulary-special-design.md
 */
@Injectable()
export class VocabularyService {
  private readonly logger = new Logger(VocabularyService.name);
  private readonly judgeCapability: EnglishWordJudgeCapability;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(
    private readonly wordsRepo: EnglishWordsRepository,
    private readonly progressRepo: StudentWordProgressRepository,
    private readonly trainingSessionsRepo: TrainingSessionsRepository,
    private readonly specialLogsRepo: SpecialPracticeLogsRepository,
    @Optional() deps?: VocabularyServiceDeps,
  ) {
    this.judgeCapability = deps?.judge ?? new EnglishWordJudgeCapability();
    this.now = deps?.now ?? (() => new Date());
    this.random = deps?.random ?? Math.random;
  }

  // ==================== 配置页 ====================

  async getOptions(studentId: number): Promise<VocabularyOptionsResult> {
    const [byLevel, stats, todayAnswered] = await Promise.all([
      this.wordsRepo.countByLevel(),
      this.wordsRepo.countPoolStats(studentId),
      this.progressRepo.countSeenSince(studentId, this.startOfToday()),
    ]);

    const count = new Map<EnglishLevel, number>(byLevel.map((r) => [r.level, r.count]));
    const sumOf = (pool: LevelPool) =>
      levelsForPool(pool).reduce((acc, lv) => acc + (count.get(lv) ?? 0), 0);

    const pools: VocabularyPoolOption[] = POOL_KEYS.map((key) => ({
      key,
      label: POOL_LABELS[key],
      count: sumOf(key),
    }));

    return {
      pools,
      todayAnswered,
      counts: {
        // 没背过 = 总数 - 背过（没进度行的算没背过）
        notLearned: stats.total - stats.learned,
        myWrong: stats.myWrong,
        commonWrong: stats.commonWrong,
        extended: stats.extended,
      },
    };
  }

  /** 服务器本地时区的当日 00:00。刻意不用 SQL 的 CURDATE()（DB 会话时区可能与应用不一致）。 */
  private startOfToday(): Date {
    const now = this.now();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  }

  // ==================== 开练（抽题） ====================

  /**
   * 抽题。**防泄漏在这里落地**：凡是**答案等于英文单词**的题（`cn2en` 与 `ph2en`）
   * **不返回** `word` / `phonetic` / `context` / `hasFamily`——词根族树里必然包含单词本身，
   * `word` 与 `hasFamily` 都可能直接把答案递出去。
   * `ph2en` 的音标只出现在 `prompt` 一处（`phonetic` 留 null），免得两处内容打架。
   *
   * **乙类整批发分（2026-09-17）**：出题后建一条 `training_sessions`，前端背完整轮调
   * `POST /api/training/sessions/:id/complete` 整批发分（10/15/20 词是三档打包价，逐词发分会
   * 退化成线性，spec §6.1）。`tier_key` 用学生选的档位（控制器白名单已校验），
   * `expected_count` 用实际出题数（词池不够/出不了题的词被跳过时会更少）。
   * **一题都没出就不建会话**——0 词的会话也能 complete 拿走整档分。
   */
  async start(input: VocabularyStartInput, studentId: number): Promise<VocabularyStartResult> {
    const count = this.normalizeCount(input.count);
    const order = this.normalizeOrder(input.order);
    // 僻义的三档判题口径（含 off_target）建立在「题面给单词 + 语境、学生答中文」之上，
    // 所以勾「只出熟词僻义」时方向强制英→中；若允许中→英，off_target 这一档将失去意义。
    const direction: VocabularyDirection = input.onlyExtendedSense ? 'en2cn' : input.direction;

    const pool = await this.wordsRepo.findPool({
      levelPool: this.normalizeLevelPool(input.levelPool),
      onlyNotLearned: input.onlyNotLearned === true,
      onlyMyWrong: input.onlyMyWrong === true,
      onlyCommonWrong: input.onlyCommonWrong === true,
      onlyExtendedSense: input.onlyExtendedSense === true,
      // 只在「指定字母开头」模式下才把字母交给仓储；字母本身在仓储里还会再白名单校验一次
      letter: order === 'letter' ? (input.letter ?? null) : null,
      studentId,
    });

    if (pool.length === 0) {
      return { questions: [], poolSize: 0, sessionId: null };
    }

    const selected = this.selectPool(pool, order, count);
    const rows = await this.wordsRepo.findByIds(selected.map((r) => r.id));
    // findByIds 用 IN 取数，返回顺序由 DB 决定；按选中顺序还原，否则「字母序」看着是乱的
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = selected.map((r) => byId.get(r.id)).filter((r): r is EnglishWordRow => r != null);

    const questions: VocabularyQuestionItem[] = [];
    for (const row of ordered) {
      const question = this.buildQuestion(row, input.onlyExtendedSense === true, direction);
      if (question) questions.push(question);
    }

    // 建会话失败**只丢这一轮的积分，不能 500 掉开练**：积分是激励层，绝不能挡住学习路径。
    // 回 `sessionId: null`，前端照常背词（与「词池为空」同一形状）。
    let sessionId: number | null = null;
    if (questions.length > 0) {
      try {
        sessionId = await this.trainingSessionsRepo.create({
          student_id: studentId,
          task_code: 'en_vocabulary',
          subject_id: null,
          tier_key: String(count),
          expected_count: questions.length,
          ref_type: 'question',
          ref_id: null,
        });
      } catch (err) {
        this.logger.warn(
          `training_sessions.create failed (taskCode=en_vocabulary, studentId=${studentId}, tierKey=${count}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { questions, poolSize: pool.length, sessionId };
  }

  /**
   * 剂量校验，**越界直接拒绝、不夹取**（2026-09-17 改）。
   *
   * 原来是 `Math.min(MAX, Math.max(MIN, n))`：把 13 悄悄夹成 15 是**静默改档**——
   * 而档位直接决定发多少分（档位打包价），静默改档就是给学生发错分。
   * 「档位即可选项」由控制器的两道校验把关（范围 + `listTierKeys` 白名单），
   * 这里只是兜底：任何绕过控制器的调用都必须**响**，而不是被悄悄改成合法档位。
   * 不做 `Number()` 强转（与控制器 `Number.isInteger` 同口径），`'15'` 这类字符串照拒不误。
   */
  private normalizeCount(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw)
        || raw < VOCABULARY_MIN_COUNT || raw > VOCABULARY_MAX_COUNT) {
      throw new BadRequestException(
        `count 仅允许 ${VOCABULARY_MIN_COUNT}-${VOCABULARY_MAX_COUNT} 的整数`,
      );
    }
    return raw;
  }

  private normalizeOrder(raw: unknown): VocabularyOrder {
    return raw === 'alpha' || raw === 'alpha_desc' || raw === 'letter' ? raw : 'random';
  }

  private normalizeLevelPool(raw: unknown): LevelPool {
    return raw === 'junior' || raw === 'senior' || raw === 'all' ? raw : 'all';
  }

  /** 排序 + 截断。（仓储已按 sort_order 返回，这里按所选模式重排，四种模式共用一次查询。） */
  private selectPool(
    pool: EnglishWordPoolRow[],
    order: VocabularyOrder,
    count: number,
  ): EnglishWordPoolRow[] {
    switch (order) {
      case 'random':
        return this.shuffle(pool).slice(0, count);
      case 'alpha':
        return [...pool].sort((a, b) => this.compareWord(a.word, b.word)).slice(0, count);
      case 'alpha_desc':
        return [...pool].sort((a, b) => this.compareWord(b.word, a.word)).slice(0, count);
      case 'letter':
        // 字母过滤已在仓储完成，这里按字母序排（「背 a 开头的词」自然是字典序）
        return [...pool].sort((a, b) => this.compareWord(a.word, b.word)).slice(0, count);
    }
  }

  /** Fisher-Yates。注入了 random 才能写出可复现的用例。 */
  private shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  private compareWord(a: string, b: string): number {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }

  /**
   * 为一个词构造一道题。返回 null 表示这个词出不了题（没有可用义项），调用方跳过。
   *
   * **普通模式下也会考僻义**（在候选里等概率抽）——用户明确说熟词僻义「特别特别重要」，
   * 若只靠「只出熟词僻义」勾选才出现，学生默认根本碰不到；而阅读完型考它的方式本来就是
   * 「给你一个搭配，看你会不会那个不常见的意思」。勾选那个选项的作用是**只留**僻义。
   *
   * 一个词只出一道题（而不是每个僻义义项各一道）：用户要的是「每天背 10-20 个**词**」，
   * 一道题对应一个词，会话长度才等于词数。
   */
  private buildQuestion(
    row: EnglishWordRow,
    onlyExtendedSense: boolean,
    direction: VocabularyDirection,
  ): VocabularyQuestionItem | null {
    const meanings = toMeanings(row.meanings);
    const commons = commonMeanings(meanings);
    const extendedIdx = extendedSenseIndexes(meanings);

    // 候选：常见义组（若存在）+ 每个僻义义项
    type Candidate = { senseIndex: number; extended: boolean };
    const candidates: Candidate[] = [];
    if (commons.length > 0) {
      candidates.push({ senseIndex: meanings.indexOf(commons[0]), extended: false });
    }
    for (const idx of extendedIdx) candidates.push({ senseIndex: idx, extended: true });

    const usable = onlyExtendedSense ? candidates.filter((c) => c.extended) : candidates;
    if (usable.length === 0) return null;

    const picked = usable[Math.floor(this.random() * usable.length) % usable.length];

    if (picked.extended) {
      // 僻义题恒为英→中：三档判题口径要求题面给出单词与锁定僻义的搭配。
      // 看音标写单词同样不行——题面只有音标，学生既看不到单词也看不到搭配，
      // 而「在搭配里认出那个不常见的意思」正是这道题的考点。
      return this.en2CnQuestion(row, picked.senseIndex, meanings);
    }

    // 常见义题：方向由用户选择决定（random 则逐题掷）
    const kind = this.resolvePromptKind(row, meanings, direction);

    if (kind === 'cn2en') {
      return {
        wordId: row.id,
        senseIndex: picked.senseIndex,
        promptKind: 'cn2en',
        prompt: primaryGloss(meanings),
        // 中→英题不给单词、音标、语境、词根族提示——每一项都足以顺出答案
        phonetic: null,
        context: null,
        isExtendedSense: false,
        hasFamily: false,
      };
    }

    if (kind === 'ph2en') {
      return this.ph2EnQuestion(row, picked.senseIndex);
    }

    return this.en2CnQuestion(row, picked.senseIndex, meanings);
  }

  /**
   * 落定本题的题面类型。**只有常见义题会走到这里**（僻义题恒为英→中，见 buildQuestion）。
   *
   * 出不了的方向**退化成英→中，而不是把这个词丢掉**——词被静默跳过，学生会以为筛选坏了：
   *   - 中→英要一个可用的中文释义
   *   - 看音标写单词要一个可用的音标（`phonetic` 列可空，也可能是空音标 `/` / `//`）
   *
   * `random` 只在**本词真出得了的方向**里等概率掷：否则掷出一个再退化，
   * 学生看到的是「选了随机却总出英→中」，与「随机」这个承诺不符。
   */
  private resolvePromptKind(
    row: EnglishWordRow,
    meanings: EnglishWordMeaning[],
    direction: VocabularyDirection,
  ): VocabularyPromptKind {
    const canCn2en = primaryGloss(meanings) !== '';
    const canPh2en = isUsablePhonetic(row.phonetic);

    if (direction === 'random') {
      const kinds: VocabularyPromptKind[] = ['en2cn'];
      if (canCn2en) kinds.push('cn2en');
      if (canPh2en) kinds.push('ph2en');
      return kinds[Math.floor(this.random() * kinds.length) % kinds.length];
    }

    if (direction === 'cn2en' && !canCn2en) {
      this.logger.warn(`[vocabulary] word#${row.id} 无可用释义，中→英退化为英→中`);
      return 'en2cn';
    }
    if (direction === 'ph2en' && !canPh2en) {
      this.logger.warn(`[vocabulary] word#${row.id} 无可用音标，看音标写单词退化为英→中`);
      return 'en2cn';
    }
    return direction;
  }

  /**
   * 看音标写单词题：题面是音标，答案是英文单词。
   *
   * 与中→英同属「一个字都不能多给」的一类：不给单词、不给语境、不给词根族
   * （族树里必然含单词本身），音标只出现在 `prompt` 一处、`phonetic` 留 null。
   */
  private ph2EnQuestion(row: EnglishWordRow, senseIndex: number): VocabularyQuestionItem {
    return {
      wordId: row.id,
      senseIndex,
      promptKind: 'ph2en',
      prompt: (row.phonetic ?? '').trim(),
      phonetic: null,
      context: null,
      isExtendedSense: false,
      hasFamily: false,
    };
  }

  private en2CnQuestion(
    row: EnglishWordRow,
    senseIndex: number,
    meanings: EnglishWordMeaning[],
  ): VocabularyQuestionItem {
    const target = meanings[senseIndex];
    return {
      wordId: row.id,
      senseIndex,
      promptKind: 'en2cn',
      prompt: row.word,
      phonetic: row.phonetic,
      context: target?.extended ? (target.context ?? null) : null,
      isExtendedSense: target?.extended === true,
      hasFamily: row.root_key != null,
    };
  }

  // ==================== 判题 ====================

  async judge(input: VocabularyJudgeInput, studentId: number): Promise<VocabularyJudgeResult> {
    const row = await this.wordsRepo.findById(input.wordId);
    if (!row) {
      throw new NotFoundException(`单词不存在：${input.wordId}`);
    }
    const meanings = toMeanings(row.meanings);
    const senseIndex = Number.isInteger(input.senseIndex) ? input.senseIndex : 0;
    const answer = typeof input.answer === 'string' ? input.answer : '';

    const route = this.resolveJudgeRoute(input.promptKind, meanings, senseIndex);
    const outcome = await this.runJudgeRoute(route, answer, row.word);

    // 记账：只有 correct 置 learned、只有 wrong 加错次（规则在 progressDelta，全系统唯一一处）
    const delta = progressDelta(outcome.verdict);
    await this.progressRepo.recordResult({
      studentId,
      wordId: row.id,
      learned: delta.learned,
      wrongDelta: delta.wrongDelta,
      lastResult: outcome.verdict,
    });
    // 全局错次与学生错次是两份统计：前者只增、供全平台易错词排序，后者可被学生「移除易错标记」清零。
    // 两次写不在同一事务里——两者都是仅用于统计的计数器，不参与判题结果与主线门禁，
    // 极端情况下只差一个计数不值得引入分布式事务的复杂度。
    if (delta.wrongDelta === 1) {
      await this.wordsRepo.incrementErrorCount(row.id);
    }

    // 专项日志（Phase 1B）：英语的作答单位是「词的一个义项」，一行记一道题。
    //
    // ⚠️ 义项下标（senseIndex）**本期不入库**：spec §4.4 的 DDL 没有这一列，且
    // `sentence_index` 的列注释写明「默写/背词为 NULL」。所以想知道「哪个义项容易错」
    // 目前做不到——那需要加列或改 spec，属 spec 变更，**先与用户确认再做**，别偷偷塞进
    // sentence_index（会污染「逐句」这个语义）或 ref_key（它语义是词面快照）。
    //
    // 入库映射：英语原始枚举叫 'wrong'，而本表的 verdict 是跨专项统一字典（没有 'wrong'），
    // 故映射成 'incorrect'。errorCounted 用**原始** verdict 走 progressDelta，不另写一套。
    const logVerdict: SpecialPracticeVerdict =
      outcome.verdict === 'wrong' ? 'incorrect' : outcome.verdict;
    try {
      await this.specialLogsRepo.insert({
        studentId,
        module: 'en_vocabulary',
        refType: 'word',
        refId: row.id,
        refKey: row.word,
        sentenceIndex: null,
        verdict: logVerdict,
        isCorrect: isCorrectOf(logVerdict),
        errorCounted: delta.wrongDelta === 1,
        // sessionUid 本期恒 null：1B 不做「学习会话 ↔ 专项作答」串联，留列给后续。
        sessionUid: null,
      });
    } catch (err) {
      // 埋点绝不阻断判题：失败只 warn
      this.logger.warn('special_practice_logs 写入失败（已忽略，不影响判题）', err);
    }

    const progress = await this.progressRepo.findByStudentAndWord(studentId, row.id);
    const target = meanings[senseIndex];

    return {
      wordId: row.id,
      senseIndex,
      verdict: outcome.verdict,
      method: outcome.method,
      standard: {
        word: row.word,
        phonetic: row.phonetic,
        meanings: meanings.map((m): VocabularyStandardMeaning => ({
          pos: m.pos,
          gloss: m.gloss,
          extended: m.extended,
          ...(m.context ? { context: m.context } : {}),
        })),
        target: {
          pos: target?.pos ?? '',
          gloss: target?.gloss ?? '',
          extended: target?.extended === true,
          ...(target?.context ? { context: target.context } : {}),
        },
      },
      spellingDiff: outcome.spellingDiff,
      comment: outcome.comment,
      familyAvailable: row.root_key != null,
      progress: {
        learned: progress?.learned === 1,
        wrongCount: progress?.wrong_count ?? 0,
      },
    };
  }

  /** 判题路由：各条路线认可的释义、LLM 模式与目标义项。 */
  private resolveJudgeRoute(
    promptKind: VocabularyPromptKind,
    meanings: EnglishWordMeaning[],
    senseIndex: number,
  ): {
    kind: VocabularyPromptKind;
    acceptableGlosses: string[];
    llmMode: EnglishWordJudgeMode;
    llmTarget: { pos: string; gloss: string };
    /** 僻义题的语境搭配。**必须传给模型**——「在搭配里认那个僻义」正是本题的考点。 */
    llmContext: string | null;
    otherGlosses: string[];
  } {
    if (promptKind === 'cn2en' || promptKind === 'ph2en') {
      // 这两个方向的答案都是英文单词，纯程序比对、不调 LLM；这里的目标义项只为返回时展示
      return {
        kind: promptKind,
        acceptableGlosses: [],
        llmMode: 'common',
        llmTarget: { pos: '', gloss: '' },
        llmContext: null,
        otherGlosses: [],
      };
    }

    const target = meanings[senseIndex];
    if (target?.extended) {
      return {
        kind: 'en2cn',
        acceptableGlosses: [target.gloss],
        llmMode: 'extended',
        llmTarget: { pos: target.pos, gloss: target.gloss },
        llmContext: target.context ?? null,
        // 学生最可能答的就是该词的常见义，必须列给模型才能判出 off_target
        otherGlosses: meanings.filter((_, i) => i !== senseIndex).map((m) => m.gloss),
      };
    }

    const commons = commonMeanings(meanings);
    if (target) {
      return {
        kind: 'en2cn',
        acceptableGlosses: commons.map((m) => m.gloss),
        llmMode: 'common',
        // 常见义模式下「本题要考的含义」把该词全部常见义并列，与「答到任一真实义项都算对」一致
        llmTarget: { pos: target.pos, gloss: commons.map((m) => m.gloss).join('；') },
        llmContext: null,
        otherGlosses: meanings.filter((m) => m.extended).map((m) => m.gloss),
      };
    }

    // senseIndex 失效（内容重灌后下标漂移、或前端传了越界值）：**宁放过不错杀**——
    // 词库是离线重灌的，学生手中这道题的题面已经无法确定，判错等于凭空冤一个正确答案。
    this.logger.warn(
      `[vocabulary] senseIndex=${senseIndex} 越界（meanings=${meanings.length}），按「全义项都接受」判`,
    );
    return {
      kind: 'en2cn',
      acceptableGlosses: meanings.map((m) => m.gloss),
      llmMode: 'common',
      llmTarget: { pos: meanings[0]?.pos ?? '', gloss: meanings.map((m) => m.gloss).join('；') },
      llmContext: null,
      otherGlosses: meanings.slice(1).map((m) => m.gloss),
    };
  }

  private async runJudgeRoute(
    route: ReturnType<VocabularyService['resolveJudgeRoute']>,
    answer: string,
    expectedWord: string,
  ): Promise<{
    verdict: VocabularyVerdict;
    method: 'exact' | 'ai';
    spellingDiff: WordCharDiffOp[] | null;
    comment: string | null;
  }> {
    // 空作答守卫：显式「不认识」不计对错（也不进任何错误统计）——「不会」不等于「易错」。
    // 答案是英文单词的方向下学生可能只打了个空格，也算没答。
    if (answer.trim() === '') {
      return { verdict: 'unanswered', method: 'exact', spellingDiff: null, comment: null };
    }

    // ---- 路由 1：答案是英文单词（中→英 / 看音标写单词），纯程序比对，不调 LLM ----
    if (route.kind === 'cn2en' || route.kind === 'ph2en') {
      const ok = isEnglishWordMatch(answer, expectedWord);
      return {
        verdict: ok ? 'correct' : 'wrong',
        method: 'exact',
        spellingDiff: ok ? null : diffWordChars(answer.trim(), expectedWord),
        comment: null,
      };
    }

    // ---- 路由 2 / 3：英→中，先程序短路 ----
    if (isGlossMatch(answer, route.acceptableGlosses)) {
      return { verdict: 'correct', method: 'exact', spellingDiff: null, comment: null };
    }

    // 未命中才调 LLM。判题失败 → undetermined：不计对错、不写错题统计。
    try {
      const res = await this.judgeCapability.generate({
        word: expectedWord,
        target: route.llmTarget,
        context: route.llmContext,
        mode: route.llmMode,
        otherGlosses: route.otherGlosses,
        studentAnswer: answer,
      });
      return {
        verdict: res.verdict,
        method: 'ai',
        spellingDiff: null,
        comment: res.comment ?? null,
      };
    } catch (err) {
      this.logger.warn(
        `[vocabulary] 判题模型失败，本题记 undetermined: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { verdict: 'undetermined', method: 'ai', spellingDiff: null, comment: null };
    }
  }

  // ==================== 易错标记 ====================

  /**
   * 「移除易错标记」：只清**该学生**的 `wrong_count`。
   * 不动 `learned`（背过就是背过），也不动 `english_words.error_count`
   * （那是全平台统计，不该被单个学生抹掉）。
   */
  async clearWrongMark(wordId: number, studentId: number): Promise<{ ok: true }> {
    await this.progressRepo.clearWrongCount(studentId, wordId);
    return { ok: true };
  }

  // ==================== 词根族 ====================

  /**
   * 点「+」号时懒加载的词根族。
   *
   * 不按题面类型设限（成绩单复盘时也要能看），但**前端必须只在英→中题上渲染入口**——
   * 族树里必然包含单词本身，中→英题点开就等于看答案。
   */
  async getFamily(wordId: number): Promise<WordFamilyResult> {
    const row = await this.wordsRepo.findById(wordId);
    if (!row) {
      throw new NotFoundException(`单词不存在：${wordId}`);
    }
    // 中心词自己的 root_key 等于自己的 word（管线保证），所以成员直接查该键
    const rootKey = row.root_key ?? row.word;
    const rows = await this.wordsRepo.findFamily(rootKey);
    if (rows.length < 2) {
      throw new NotFoundException(`该词没有词根族：${wordId}`);
    }

    const head = rows.find((r) => r.word === rootKey);
    const toMember = (r: EnglishWordRow): WordFamilyMember => {
      const meanings = toMeanings(r.meanings);
      return {
        word: r.word,
        phonetic: r.phonetic,
        gloss: primaryGloss(meanings),
        pos: meanings[0]?.pos ?? '',
        // 中心词不带词缀注记（它是族根，不是派生来的）
        affixes: r.word === rootKey ? [] : toRootAffixes(r.root_affixes),
        isHead: r.word === rootKey,
        level: r.level as EnglishLevel,
      };
    };

    return {
      root: {
        word: rootKey,
        phonetic: head?.phonetic ?? null,
        gloss: head ? primaryGloss(toMeanings(head.meanings)) : '',
      },
      // 中心词排最前，其余保持仓储的 sort_order 顺序
      members: [
        ...(head ? [toMember(head)] : []),
        ...rows.filter((r) => r.id !== head?.id).map(toMember),
      ],
    };
  }
}
