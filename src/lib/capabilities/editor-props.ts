import type { StructuredAuthoringProps } from './types';

/**
 * 编辑器页下发给客户端的能力结果（ADR 0058 §5.1）：无权时不下发任何标签页数据，
 * 只保留 allowed / denial，授权来源（含 grantId）一律清空。
 */
export function toEditorAuthoringProps(entitlement: StructuredAuthoringProps): StructuredAuthoringProps {
  if (entitlement.allowed) return entitlement;
  return entitlement.denial
    ? { allowed: false, denial: entitlement.denial, sources: [] }
    : { allowed: false, sources: [] };
}
