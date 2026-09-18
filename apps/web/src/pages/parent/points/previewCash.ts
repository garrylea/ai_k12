/**
 * 现金兑换的金额预览 —— 「积分 → 钱」方向，家长输入积分、金额被推导。
 *
 * **必须与后端 `redemption.service.ts` 同口径**：
 * `Math.round((points / perYuan) * 100) / 100` 会踩浮点误差（points=201 / perYuan=200 时
 * `201/200*100 = 100.49999999999999` → 1.00，正确值是 1.01），所以先整数运算再除。
 *
 * 独立成模块有两个理由：兑换表单的实时预览与兑换设置的示例文案共用同一份实现
 * （不允许各写一份），且纯函数便于单独断言取整口径（计划三 §3 Task 7）。
 */
export function previewCashAmount(points: number, perYuan: number): number {
  return Math.round((points * 100) / perYuan) / 100;
}
