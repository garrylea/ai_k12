import { Injectable } from '@nestjs/common';

/**
 * 做题入口判题服务 —— **临时占位**（Task 7 只为让 controller/module 编译通过）。
 *
 * 真正的实现（判题流 + 落库 + SSE）由 Task 9/10 补齐；在那之前任何调用都必须
 * 显式失败，不能静默返回空结果骗过调用方。
 */
@Injectable()
export class FreeformJudgeService {
  /**
   * 占位：Task 9/10 会改成流式判题。只声明形状，调用即抛。
   */
  async *judgeStream(): AsyncGenerator<never, void, unknown> {
    throw new Error('FreeformJudgeService not implemented');
  }
}
