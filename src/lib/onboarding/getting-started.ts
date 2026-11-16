/**
 * @module lib/onboarding/getting-started
 *
 * 仪表盘「上手清单」的条目与完成判定（#796），纯函数，服务端算信号、客户端渲染共用。
 *
 * <p>条目按角色区分：
 * - 平台管理员：沿用原 admin 启动板的五项（建策略、API key、AI key、邀请成员、账单）；
 * - 普通用户：自己的第一步（建策略、运行、加入或组建团队、提交审批），外加可选的「连接 Guard」。
 *
 * <p>原注册后的两步偏好向导并入清单，成为可选的「偏好」条目（在卡片内就地填写）。
 * 可选条目不计入进度，也不阻止卡片在必做条目全部完成后隐藏——已完成或跳过旧向导的老用户不会被要求补填。
 *
 * <p>完成状态全部来自真实数据（见 getting-started-signals.ts），按用户计算，不新增存储。
 */

import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';

export interface GettingStartedSignals {
  /** 已保存使用场景与目标（users.onboardingCompletedAt 非空）。 */
  hasPreferences: boolean;
  hasPolicy: boolean;
  /** 至少执行过一次策略。 */
  hasRun: boolean;
  /** 与其他人同在一个团队，或已向自己所在团队发出邀请。 */
  hasTeammate: boolean;
  /** 至少提交过一次版本审批。 */
  hasSubmittedApproval: boolean;
  /** 至少有一次执行登记了 Guard 决策。 */
  hasGuardDecision: boolean;
  hasApiKey: boolean;
  hasAiKey: boolean;
  hasReviewedBilling: boolean;
}

export type GettingStartedItemId =
  | 'preferences'
  | 'createPolicy'
  | 'runPolicy'
  | 'joinTeam'
  | 'submitApproval'
  | 'connectGuard'
  | 'addApiKey'
  | 'addAiKey'
  | 'inviteTeam'
  | 'reviewBilling';

/** 条目的入口：站内链接、在文档浮层打开某篇文档、或展开卡片内的偏好表单。 */
export type GettingStartedAction =
  | { kind: 'link'; href: string }
  | { kind: 'docs'; slug: string }
  | { kind: 'preferences' };

export interface GettingStartedItem {
  id: GettingStartedItemId;
  done: boolean;
  optional: boolean;
  action: GettingStartedAction;
}

export interface GettingStartedInput {
  signals: GettingStartedSignals;
  isAdmin: boolean;
  /** 用户最近更新的策略 id，「运行」「提交审批」直接落到它；没有策略时落到策略列表。 */
  firstPolicyId: string | null;
}

const link = (href: string): GettingStartedAction => ({ kind: 'link', href });

function policyHref(firstPolicyId: string | null, sub: 'execute' | 'versions'): GettingStartedAction {
  return link(firstPolicyId ? `/policies/${encodeURIComponent(firstPolicyId)}/${sub}` : '/policies');
}

export function buildGettingStartedItems({ signals: s, isAdmin, firstPolicyId }: GettingStartedInput): GettingStartedItem[] {
  const preferences: GettingStartedItem = { id: 'preferences', done: s.hasPreferences, optional: true, action: { kind: 'preferences' } };
  const createPolicy: GettingStartedItem = { id: 'createPolicy', done: s.hasPolicy, optional: false, action: link('/policies/new') };

  if (isAdmin) {
    const items: GettingStartedItem[] = [
      preferences,
      createPolicy,
      { id: 'addApiKey', done: s.hasApiKey, optional: false, action: link('/settings/api-keys') },
      { id: 'addAiKey', done: s.hasAiKey, optional: false, action: link('/settings/ai-keys') },
      { id: 'inviteTeam', done: s.hasTeammate, optional: false, action: link('/teams') },
    ];
    // 账单条目仅 SaaS：on-prem 没有 /billing 路由。直接以 CLIENT_CAPABILITIES 判定（而不是传参），
    // verify-on-prem-ui 扫描产物时据此把紧随其后的 '/billing' 字面量认作已门控。
    if (CLIENT_CAPABILITIES.billing) {
      items.push({ id: 'reviewBilling', done: s.hasReviewedBilling, optional: false, action: link('/billing') });
    }
    return items;
  }

  return [
    preferences,
    createPolicy,
    { id: 'runPolicy', done: s.hasRun, optional: false, action: policyHref(firstPolicyId, 'execute') },
    { id: 'joinTeam', done: s.hasTeammate, optional: false, action: link('/teams') },
    { id: 'submitApproval', done: s.hasSubmittedApproval, optional: false, action: policyHref(firstPolicyId, 'versions') },
    { id: 'connectGuard', done: s.hasGuardDecision, optional: true, action: { kind: 'docs', slug: 'how-to/guard' } },
  ];
}

/** 进度只数必做条目；必做全部完成即 complete（卡片隐藏）。 */
export function summarizeGettingStarted(items: readonly GettingStartedItem[]): { done: number; total: number; complete: boolean } {
  const required = items.filter((i) => !i.optional);
  const done = required.filter((i) => i.done).length;
  return { done, total: required.length, complete: done === required.length };
}
