import { describe, it, expect, vi } from 'vitest';
import { FreeformController } from './freeform.controller.js';

function make(recognize = vi.fn().mockResolvedValue({ candidates: [], figures: [] })) {
  const recognizeService = { recognize } as any;
  const judgeService = { judgeStream: vi.fn() } as any;
  return { controller: new FreeformController(recognizeService, judgeService), recognize };
}

describe('FreeformController.recognize', () => {
  it('recognize 透传 text/fileIds + studentId', async () => {
    const { controller, recognize } = make();

    const res = await controller.recognize(
      { text: '第5题', fileIds: ['1', '2'] },
      { sub: 9 } as any,
    );

    expect(recognize).toHaveBeenCalledWith({ text: '第5题', fileIds: ['1', '2'] }, 9);
    expect(res).toEqual({ candidates: [], figures: [] });
  });

  it('未带 fileIds 时按空数组透传（纯文字短路由 service 处理）', async () => {
    const { controller, recognize } = make();

    await controller.recognize({ text: '解方程' }, { sub: 3 } as any);

    expect(recognize).toHaveBeenCalledWith({ text: '解方程', fileIds: [] }, 3);
  });

  it('fileIds 非数组/超 6 张 → 400/1001', async () => {
    const { controller, recognize } = make();

    await expect(
      controller.recognize({ fileIds: 'x' } as any, { sub: 1 } as any),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(
      controller.recognize(
        { fileIds: ['1', '2', '3', '4', '5', '6', '7'] },
        { sub: 1 } as any,
      ),
    ).rejects.toMatchObject({ response: { code: 1001 } });

    expect(recognize).not.toHaveBeenCalled();
  });

  it('text 非字符串 → 400/1001（不能落到 service 的 trim 上）', async () => {
    const { controller, recognize } = make();

    await expect(
      controller.recognize({ text: 123 } as any, { sub: 1 } as any),
    ).rejects.toMatchObject({ response: { code: 1001 } });

    expect(recognize).not.toHaveBeenCalled();
  });

  it('fileIds 元素非正整数 → 400/1001', async () => {
    const { controller, recognize } = make();

    await expect(
      controller.recognize({ fileIds: ['abc'] }, { sub: 1 } as any),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(
      controller.recognize({ fileIds: ['0'] }, { sub: 1 } as any),
    ).rejects.toMatchObject({ response: { code: 1001 } });

    expect(recognize).not.toHaveBeenCalled();
  });
});
