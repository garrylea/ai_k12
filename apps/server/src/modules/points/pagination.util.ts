import { BadRequestException } from '@nestjs/common';

/**
 * `page` / `pageSize` 的分页默认值与上界（spec §7.1）。
 *
 * 学生端 `GET /api/points/me/ledger`（Task 7）与家长端
 * `GET /api/parent/students/:id/points/ledger`（Task 8）**共用这一份**——两个入口若各写一套
 * 校验迟早漂移。越界一律 400，**不静默钳制**。
 */
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * 解析 query 里的正整数字符串。**未传（undefined / 空串）取默认值；给了但非法就 400**。
 *
 * 不用 `ParseIntPipe`：它对未传的一律抛 400，表达不了「可选 + 默认值」。
 * 用正则而不是 `parseInt`：`parseInt('12abc')` 会安静地返回 12、`parseInt('1.5')` 返回 1，
 * 都是把非法输入当合法接受——本模块要求越界/非法一律 400。
 */
export function parsePositiveInt(raw: string | undefined, name: string, def: number, max?: number): number {
  if (raw === undefined || raw === '') return def;
  // 正则挡掉 '12abc' / '1.5' / '-1' / ' 1'；Number.isSafeInteger 再挡掉超出 safe range 的
  // 超长数字串（`page=99999999999999999999` 会算出一个 1e21 的 offset 直送 SQL 的 LIMIT）
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value)) {
    throw new BadRequestException({ code: 1001, message: `${name} 必须是正整数（收到 ${raw}）` });
  }
  if (value < 1) {
    throw new BadRequestException({ code: 1001, message: `${name} 必须不小于 1（收到 ${raw}）` });
  }
  if (max !== undefined && value > max) {
    throw new BadRequestException({ code: 1001, message: `${name} 不能大于 ${max}（收到 ${raw}）` });
  }
  return value;
}
