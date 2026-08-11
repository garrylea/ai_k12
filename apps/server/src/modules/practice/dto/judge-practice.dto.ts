/**
 * 课堂练习判对错请求 DTO。
 *
 * 注：当前项目未安装 class-validator / class-transformer，也未配置全局
 * ValidationPipe（见 main.ts）。此处沿用既有 DTO 模式（plain interface，
 * 参考 CreateAuxErrorDto），待后续统一接入校验管线时再补装饰器。
 */
export interface JudgePracticeDto {
  cardId: number;
  lessonId: number;
  subjectId: number;
  questionN: string;
  questionText: string;
  studentAnswer: string;
}
