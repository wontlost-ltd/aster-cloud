/**
 * 新建页与编辑页共用的保存请求体与响应解析（只做形状转换，不发请求）。
 *
 * - 请求体：表单字段 + 策略 CNL 语言 + 两个三态字段。layout（ADR 0058 §7.5）与 embeddedVocabulary
 *   （ADR 0060 §6.5）都只在上下文里出现时才写进请求体：省略即由服务端按路由规则处理（PUT 沿用活跃版本）。
 *   表单字段里的内嵌词汇只用于草稿与改动判定，一律不按字段原样展开——否则无能力的作者每次保存都会把它发出去。
 * - 响应：`vocabularyShadowed` 列出被本策略内嵌词条遮蔽的团队 / 个人词条，形状不符的元素丢弃。
 */
import type { ShadowedTerm } from '@/lib/policy-embedded-vocabulary';
import type { PolicySaveContext } from './index';
import type { PolicyDraftFields } from './use-policy-draft';

export function policySaveBody(
  fields: PolicyDraftFields,
  context: PolicySaveContext,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const { embeddedVocabulary: _formValue, ...rest } = fields;
  void _formValue;
  return {
    ...rest,
    ...extra,
    locale: context.locale,
    ...(context.layout !== undefined ? { layout: context.layout } : {}),
    ...(context.embeddedVocabulary !== undefined ? { embeddedVocabulary: context.embeddedVocabulary } : {}),
  };
}

function isShadowedTerm(value: unknown): value is ShadowedTerm {
  if (typeof value !== 'object' || value === null) return false;
  const term = value as Record<string, unknown>;
  return (
    typeof term.kind === 'string' &&
    typeof term.localized === 'string' &&
    typeof term.canonical === 'string' &&
    (term.source === 'team' || term.source === 'author')
  );
}

/** 保存响应里的 vocabularyShadowed；缺省或非数组为空。 */
export function vocabularyShadowedOf(data: unknown): ShadowedTerm[] {
  const list = (data as { vocabularyShadowed?: unknown } | null)?.vocabularyShadowed;
  return Array.isArray(list) ? list.filter(isShadowedTerm) : [];
}
