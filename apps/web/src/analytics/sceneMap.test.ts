import { describe, it, expect } from 'vitest';
import { mapScene } from './sceneMap';

/**
 * 所有 `isStudyScene: true` 的路由（pathname → 期望的 module/scene）。
 *
 * 同一份表驱动两个地方：① 逐条钉住映射结果；② 「白名单守卫」describe 检查这些取值
 * 都在后端封闭字典内。**新增学习规则时这里必须加一行**，否则守卫看不到它。
 */
const STUDY_ROUTES: Array<[string, string, string]> = [
  ['/student/course-detail', 'mainline', 'course_detail'],
  ['/student/auxiliary', 'aux_qna', 'aux_chat'],
  ['/student/training/targeted/run', 'training_targeted', 'targeted_run'],
  ['/student/training/errors/run', 'training_error_practice', 'error_run'],
  ['/student/training/exam/run/42', 'exam', 'exam_run'],
  ['/student/training/chinese/dictation/run', 'chinese_dictation', 'dictation_run'],
  ['/student/training/chinese/interpretation/run', 'chinese_interpretation', 'interpretation_run'],
  ['/student/training/chinese/meaning/run', 'chinese_meaning', 'meaning_run'],
  ['/student/training/english/vocabulary/run', 'en_vocabulary', 'vocabulary_run'],
];

describe('mapScene', () => {
  it.each(STUDY_ROUTES)('%s → %s/%s（学习会话=true）', (path, module, scene) => {
    expect(mapScene(path)).toEqual({ module, scene, isStudyScene: true });
  });

  it('带 query 的学习路由仍然命中同一场景', () => {
    expect(mapScene('/student/course-detail?lessonId=3')).toEqual({
      module: 'mainline',
      scene: 'course_detail',
      isStudyScene: true,
    });
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

/**
 * 白名单守卫：学习路由的 `module` / `scene` 必须落在后端封闭字典内。
 *
 * 为什么值得单独钉：这两个取值写错（比如把 `en_vocabulary` 写成 `english_vocabulary`，
 * 或改 `types.ts` 的联合时拼错）**`tsc` 不会报错**——只要前后端对得上就类型正确。但后端
 * `start()` 会用 1001 拒掉，前端**没有任何提示**，表现为「会话静默全丢、家长端时长永远是空」。
 */
describe('白名单守卫（学习路由的 module/scene 必须在后端封闭字典内）', () => {
  // 后端白名单的**本地副本**（故意复制，前端不 import 服务端代码）。
  // 真源：apps/server/src/modules/analytics/study-sessions.service.ts 的 STUDY_MODULES / STUDY_SCENES。
  const BACKEND_MODULES = [
    'mainline',
    'aux_qna',
    'training_targeted',
    'training_error_practice',
    'exam',
    'chinese_dictation',
    'chinese_interpretation',
    'chinese_meaning',
    'en_vocabulary',
  ];
  const BACKEND_SCENES = [
    'course_detail',
    'star_map',
    'aux_chat',
    'targeted_run',
    'error_run',
    'exam_run',
    'dictation_run',
    'interpretation_run',
    'meaning_run',
    'vocabulary_run',
    'profile',
    'rewards',
  ];

  it('本地副本的条数与后端一致（9 个 module / 12 个 scene），防止抄漏', () => {
    expect(BACKEND_MODULES).toHaveLength(9);
    expect(BACKEND_SCENES).toHaveLength(12);
  });

  it.each(STUDY_ROUTES)('%s 的 module/scene 都在后端白名单内', (path) => {
    const info = mapScene(path);
    expect(info.isStudyScene).toBe(true);
    expect(BACKEND_MODULES).toContain(info.module);
    expect(BACKEND_SCENES).toContain(info.scene);
  });

  it('4 个仅用于归属的前端值确实不在后端白名单内（所以开会话的闸门只能是 sceneKey）', () => {
    expect(BACKEND_MODULES).not.toContain('parent');
    expect(BACKEND_MODULES).not.toContain('admin');
    expect(BACKEND_SCENES).not.toContain('parent_dashboard');
    expect(BACKEND_SCENES).not.toContain('admin_dashboard');
  });
});
