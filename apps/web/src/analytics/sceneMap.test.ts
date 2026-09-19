import { describe, it, expect } from 'vitest';
import { mapScene } from './sceneMap';

describe('mapScene', () => {
  it.each([
    ['/student/course-detail', 'mainline', 'course_detail', true],
    ['/student/course-detail?lessonId=3', 'mainline', 'course_detail', true],
    ['/student/auxiliary', 'aux_qna', 'aux_chat', true],
    ['/student/training/targeted/run', 'training_targeted', 'targeted_run', true],
    ['/student/training/errors/run', 'training_error_practice', 'error_run', true],
    ['/student/training/exam/run/42', 'exam', 'exam_run', true],
    ['/student/training/chinese/dictation/run', 'chinese_dictation', 'dictation_run', true],
    ['/student/training/chinese/interpretation/run', 'chinese_interpretation', 'interpretation_run', true],
    ['/student/training/chinese/meaning/run', 'chinese_meaning', 'meaning_run', true],
    ['/student/training/english/vocabulary/run', 'en_vocabulary', 'vocabulary_run', true],
  ])('%s → %s/%s（学习会话=%s）', (path, module, scene, isStudy) => {
    expect(mapScene(path)).toEqual({ module, scene, isStudyScene: isStudy });
  });

  it.each([
    ['/student/star-map', 'mainline', 'star_map'],
    ['/student/subjects', null, null],
    ['/student/entry', null, null],
    ['/student/profile', null, 'profile'],
    ['/student/rewards', null, 'rewards'],
    ['/parent/dashboard', 'parent', 'parent_dashboard'],
    ['/admin/analytics', 'admin', 'admin_dashboard'],
  ])('%s → 非学习场景，只定位 module/scene', (path, module, scene) => {
    expect(mapScene(path)).toEqual({ module, scene, isStudyScene: false });
  });

  it.each([['/login'], ['/register'], ['/'], ['/unknown/path']])(
    '%s → 完全不记（module/scene 都是 null）',
    (path) => {
      expect(mapScene(path)).toEqual({ module: null, scene: null, isStudyScene: false });
    },
  );

  it('配置页不算学习会话（避免把「挑题 10 分钟」算成学习时长）', () => {
    expect(mapScene('/parent/students/11/config').isStudyScene).toBe(false);
    expect(mapScene('/student/star-map').isStudyScene).toBe(false);
  });

  it('忽略 query 与 hash（同页带参数跳转不应重开会话）', () => {
    expect(mapScene('/student/training/targeted/run?session=9#top')).toEqual(
      mapScene('/student/training/targeted/run'),
    );
  });
});
