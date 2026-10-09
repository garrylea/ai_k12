import { describe, it, expect, vi } from 'vitest';
import { PracticeController } from './practice.controller';

function makeController() {
  const service = { getHint: vi.fn().mockResolvedValue({ hint: '提示' }) };
  const events = { track: vi.fn() };
  return { controller: new PracticeController(service as never, events as never), service, events };
}

const USER = { sub: 7, role: 'student' as const };

describe('PracticeController.hint — 埋点（hint_requested）', () => {
  it('track 收到 event=hint_requested、module=mainline、scene=course_detail；主线照常透传 service', async () => {
    const { controller, service, events } = makeController();
    await controller.hint({ cardId: 3, lessonId: 5, subjectId: 2, questionText: '1+1=?' } as never, USER);

    expect(events.track).toHaveBeenCalledTimes(1);
    expect(events.track).toHaveBeenCalledWith(expect.objectContaining({
      event: 'hint_requested',
      source: 'server',
      studentId: 7,
      module: 'mainline',
      scene: 'course_detail',
      refType: 'question',
      refId: null,
    }));
    expect(service.getHint).toHaveBeenCalledWith({
      studentId: 7, subjectId: 2, cardId: 3, lessonId: 5, questionText: '1+1=?',
    });
  });
});
