/*
 * 能力解析的共享类型（ADR 0058 §4.4、§4.10）。
 * 只放类型：客户端组件（编辑器侧栏）也会引用，必须不带任何服务端依赖。
 */

export type EntitlementDenial = 'unavailable' | 'disabled' | 'plan_required' | 'not_granted';

export type GrantSource =
  | { kind: 'admin' }
  | { kind: 'direct'; grantId: string }
  | { kind: 'team'; grantId: string; teamId: string }
  | { kind: 'delegated'; grantId: string; teamId: string };

/** 编辑器页服务端解析 structured_authoring 后传给侧栏的结果，与 allowStructuralAliases 同一路径下发。 */
export interface StructuredAuthoringProps {
  allowed: boolean;
  denial?: EntitlementDenial;
  sources: GrantSource[];
}
