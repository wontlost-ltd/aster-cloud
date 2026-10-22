/**
 * 管理员概览「最近管理事件」的事件名本地化（F17）。
 *
 * AuditLog.action 是写入方自定的点分 id（"lexicon.term.add"、"ai-key.update"），直接
 * 展示对管理员不友好。这里登记已知 id，文案键由 id 机械推导为 camelCase
 * （"ai-key.reset-quota" → "aiKeyResetQuota"），放在 admin.pulse.audit.events 下。
 * 未登记的 id（新写入方尚未补文案）回落成去掉分隔符的可读形式，而不是显示 key 路径。
 */

/** 已登记、在四语文案中都有标签的审计 action id。新增写入方时同步追加并补文案。 */
export const KNOWN_ADMIN_EVENT_IDS = [
  'policy.create',
  'policy.update',
  'policy.delete',
  'policy.execute',
  'policy.publish',
  'policy.archive',
  'policy.shared',
  'policy.share.reaffirmed',
  'policy.share.permission_changed',
  'policy.share.revoked',
  'team.create',
  'team.member.add',
  'team.member.remove',
  'team.transfer',
  'subscription.upgrade',
  'subscription.downgrade',
  'subscription.cancelled',
  'subscription.auto_downgraded',
  'subscription.trial_will_end',
  'subscription.seats_reconciled',
  'payment.succeeded',
  'payment.failed',
  'payment.failed_trial_downgrade',
  'payment.dispute_created',
  'api-key.create',
  'api-key.revoke',
  'ai-key.create',
  'ai-key.update',
  'ai-key.reset-quota',
  'ai-key.reorder',
  'ai-key.delete',
  'ai-circuit.trip',
  'ai-circuit.release',
  'user.delete',
  'user.risk_tier_overridden',
  'user.risk_tier_raised',
  'user.risk_tier_decayed',
  'user.hard_purged',
  'settings.update',
  'lexicon.term.add',
  'lexicon.term.modify',
  'lexicon.term.delete',
  'lexicon.term.restore',
  'lexicon.availability.enable',
  'lexicon.availability.disable',
  'byok.allowlist.add',
  'byok.allowlist.remove',
  'license.revoked',
  'license.revocation_undone',
  'license.revocation_republished',
  'rule_regression.freeze',
  'rule_regression.run',
  'rule_regression.approve-drift',
  'rule_regression.revoke-approval',
  'rule_regression.approve-transition',
  'rule_regression.revoke-transition',
  'aha.first_policy_published',
  'docs.jump',
] as const;

const KNOWN = new Set<string>(KNOWN_ADMIN_EVENT_IDS);

/** 事件 id → 文案键（camelCase）。 */
export function adminEventLabelKey(id: string): string {
  return id
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

/** 未登记 id 的可读兜底："lexicon.term.add" → "lexicon term add"。 */
export function humanizeEventId(id: string): string {
  return id.split(/[._-]+/).filter(Boolean).join(' ');
}

/**
 * 解析事件标签：已登记的 id 用 translate(文案键)，其余回落 humanizeEventId。
 * translate 由调用方注入（服务端 getTranslations / 客户端 useTranslations 皆可）。
 */
export function adminEventLabel(id: string, translate: (key: string) => string): string {
  return KNOWN.has(id) ? translate(adminEventLabelKey(id)) : humanizeEventId(id);
}
