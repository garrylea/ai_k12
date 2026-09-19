import { Injectable } from '@nestjs/common';
import { SpecialPracticeLogsRepository } from '../../database/repositories/special-practice-logs.repo.js';
import type { SpecialPracticeModule } from '../../database/repositories/special-practice-logs.repo.js';
import { resolveRange } from './window.util.js';
import { toRate } from './rate.util.js';
import type { SpecialModuleSummary, SpecialsSummary } from './dto/parent-insights.dto.js';

/** 响应键（短名）→ 表里的 module（长名）。响应形状按 spec §8.2，用短名。 */
const MODULE_BY_KEY: Record<keyof SpecialsSummary, SpecialPracticeModule> = {
  dictation: 'chinese_dictation',
  interpretation: 'chinese_interpretation',
  meaning: 'chinese_meaning',
  vocabulary: 'en_vocabulary',
};

/**
 * 家长端专项学情（spec §8.2 `/specials`）：**只读聚合** `special_practice_logs`。
 *
 * 三条口径：
 *   1. **四个模块一定都在响应里**——没有数据的模块给 `units=0 / rate=null / byDay=[]`，
 *      让前端不必判空（与「未绑知识点时是空数组」同规矩）。
 *   2. `rate = toRate(answered, correct)`，`answered` 由仓储用 `is_correct IS NOT NULL` 统计
 *      （排除「没有明确对错」的行）。**`answered=0` → `null`，不是 0**。
 *   3. 只有 vocabulary 多一个 `newWords`（窗口内答对过的去重词数），其余三个模块没有这个键。
 */
@Injectable()
export class SpecialsService {
  constructor(private readonly logsRepo: SpecialPracticeLogsRepository) {}

  async getSpecials(studentId: number, from?: string, to?: string): Promise<SpecialsSummary> {
    // 窗口由应用层算（不用 CURDATE()）；resolveRange 的语义与 1A 的 study-time 完全一致
    // （字段名是 start / endExclusive——不是 from / to）
    const window = resolveRange(from, to);

    const [agg, byDay, newWords] = await Promise.all([
      this.logsRepo.aggregateByModule(studentId, window.start, window.endExclusive),
      this.logsRepo.countByDayByModule(studentId, window.start, window.endExclusive),
      this.logsRepo.countDistinctCorrectWords(studentId, window.start, window.endExclusive),
    ]);

    const build = (module: SpecialPracticeModule): SpecialModuleSummary => {
      const row = agg.find((a) => a.module === module);
      return {
        units: row?.units ?? 0,
        correct: row?.correct ?? 0,
        rate: toRate(row?.answered ?? 0, row?.correct ?? 0),
        byDay: byDay.filter((d) => d.module === module).map((d) => ({ date: d.day, count: d.count })),
      };
    };

    return {
      dictation: build(MODULE_BY_KEY.dictation),
      interpretation: build(MODULE_BY_KEY.interpretation),
      meaning: build(MODULE_BY_KEY.meaning),
      vocabulary: { ...build(MODULE_BY_KEY.vocabulary), newWords },
    };
  }
}
