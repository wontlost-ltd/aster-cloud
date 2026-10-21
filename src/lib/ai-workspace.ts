import { IS_SAAS } from '@/lib/deployment-mode';

/**
 * AI 工作台（ADR 0049）的部署配置。全部在调用时通过参数传入环境变量（不在模块顶层读取），
 * 以满足 middleware 导入链不得在加载期触及 process.env 的约束。
 */
export const AI_WORKSPACE_NEXT_PATTERN = /^\/(panel(\?policyId=[A-Za-z0-9_-]{1,64})?)?$/;

/** 解析工作台基础地址：未设置、非法或非 https（localhost 除外）时返回 null，表示功能关闭。 */
export function resolveAiWorkspaceBase(configured?: string): string | null {
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** 工作台 origin，供 postMessage 校验与 CSP frame-src 使用。 */
export function aiWorkspaceOrigin(configured?: string): string | null {
  const base = resolveAiWorkspaceBase(configured);
  return base ? new URL(base).origin : null;
}

/** 灰度开关：地址缺失或非 SaaS 一律关闭；'all' 全量；否则按用户 id 名单。 */
export function isAiWorkspaceEnabledFor(userId: string, base?: string | null, enabledFor?: string): boolean {
  if (!IS_SAAS || !base) return false;
  const list = (enabledFor ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes('all') || list.includes(userId);
}
