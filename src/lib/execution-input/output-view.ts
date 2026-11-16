/**
 * 执行输出的日志面视图（cloud#772，ADR 0042 §12.6 的输出侧延伸）。
 *
 * 策略可以返回由 `@pii` 输入派生的值（如 `"Hello, " + applicant.name`），返回类型又没有字段级 `@pii`，
 * 无法按声明打码。这里沿用输入面的第二层口径：对输出的**字符串叶子**过一遍与 aster-api `PIIRedactor`
 * 相同的正则（含空白 / 规范 UUID 豁免，见 redactPlainString），对象与数组递归，非字符串叶子原样保留。
 *
 * 局限：只能捕获正则覆盖的模式（SSN、邮箱、电话、信用卡、IP），**无法识别任意派生**（例如只含姓名的 "Hello, John Smith!" 不会被改动）。
 * 与输入一致：日志面任何人都拿不到原值，不提供解除；原始 `Execution.output` 仍照常存储，
 * 执行人在执行页看到的是自己这次请求的响应，不经日志读路径。
 */

import { redactPlainString } from './input-view';

/** 超过此嵌套深度的子树整体替换为占位串（fail-closed，同时避免病态深度的递归开销）。 */
const MAX_OUTPUT_DEPTH = 64;
const DEPTH_EXCEEDED = '[output too deep]';

function redactNode(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactPlainString(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_OUTPUT_DEPTH) return DEPTH_EXCEEDED;
  if (Array.isArray(value)) return value.map((item) => redactNode(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactNode(v, depth + 1)]));
}

/** 日志面读路径唯一的输出出口：不修改入参，返回新结构。 */
export function renderMaskedExecutionOutput(output: unknown): unknown {
  return redactNode(output, 0);
}
