import { materialPositionFor } from '../../common/subject-config.js';
import { parseOptions } from '../../common/utils/parse-options.util.js';

export interface FeaturedRunQuestion {
  questionId: number;
  text: string;
  type: string;
  options: unknown[] | null;
  materialText: string | null;
  materialUrl: string | null;
  subNo: number;
  materialPosition: 'before' | null;
  source: string | null;
  questionNo: number | null;
}

export function toFeaturedRunQuestion(q: {
  id: number; subject_id: number; content: string; type: string; options: string | null;
  material_text: string | null; material_url: string | null; sub_no?: number | null;
  source?: string | null; question_no?: number | null;
}): FeaturedRunQuestion {
  return {
    questionId: Number(q.id),
    text: q.content,
    type: q.type,
    options: parseOptions(q.options),
    materialText: q.material_text ?? null,
    materialUrl: q.material_url ?? null,
    subNo: Number(q.sub_no ?? 0),
    materialPosition: materialPositionFor(q.subject_id),
    source: q.source ?? null,
    questionNo: q.question_no ?? null,
  };
}
