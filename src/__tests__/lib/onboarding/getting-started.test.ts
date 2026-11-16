/**
 * 「上手清单」条目与完成判定（#796）。
 *
 * 条目按角色区分：平台管理员保留原 admin 启动板的五项，普通用户是自己的第一步（建策略、运行、团队、提交审批、
 * 可选的 Guard）；原两步偏好向导并入为可选的「偏好」条目。完成状态全部由真实数据派生，可选条目不计入进度，
 * 必做条目全部完成即整张卡片隐藏。
 */
import { describe, expect, it, vi } from 'vitest';

const caps = vi.hoisted(() => ({ billing: true }));
vi.mock('@/hooks/use-deployment-mode', () => ({ CLIENT_CAPABILITIES: caps }));
import {
  buildGettingStartedItems,
  summarizeGettingStarted,
  type GettingStartedSignals,
} from '@/lib/onboarding/getting-started';

const NONE: GettingStartedSignals = {
  hasPreferences: false,
  hasPolicy: false,
  hasRun: false,
  hasTeammate: false,
  hasSubmittedApproval: false,
  hasGuardDecision: false,
  hasApiKey: false,
  hasAiKey: false,
  hasReviewedBilling: false,
};

const ids = (items: ReturnType<typeof buildGettingStartedItems>) => items.map((i) => i.id);

describe('buildGettingStartedItems', () => {
  it('regular users get their own first steps, preferences and Guard optional', () => {
    const items = buildGettingStartedItems({ signals: NONE, isAdmin: false, firstPolicyId: null });
    expect(ids(items)).toEqual(['preferences', 'createPolicy', 'runPolicy', 'joinTeam', 'submitApproval', 'connectGuard']);
    expect(items.filter((i) => i.optional).map((i) => i.id)).toEqual(['preferences', 'connectGuard']);
  });

  it('platform admins keep the admin items, billing only when the deployment has billing', () => {
    const saas = buildGettingStartedItems({ signals: NONE, isAdmin: true, firstPolicyId: null });
    expect(ids(saas)).toEqual(['preferences', 'createPolicy', 'addApiKey', 'addAiKey', 'inviteTeam', 'reviewBilling']);
    caps.billing = false;
    const onPrem = buildGettingStartedItems({ signals: NONE, isAdmin: true, firstPolicyId: null });
    caps.billing = true;
    expect(ids(onPrem)).not.toContain('reviewBilling');
  });

  it('each item completes from its own signal', () => {
    const signals: GettingStartedSignals = {
      ...NONE,
      hasPreferences: true,
      hasRun: true,
      hasSubmittedApproval: true,
      hasGuardDecision: true,
    };
    const items = buildGettingStartedItems({ signals, isAdmin: false, firstPolicyId: 'p1' });
    const done = Object.fromEntries(items.map((i) => [i.id, i.done]));
    expect(done).toEqual({
      preferences: true,
      createPolicy: false,
      runPolicy: true,
      joinTeam: false,
      submitApproval: true,
      connectGuard: true,
    });
  });

  it('run and submit link to the first policy when there is one, else to the policy list', () => {
    const withPolicy = buildGettingStartedItems({ signals: NONE, isAdmin: false, firstPolicyId: 'p 1' });
    const byId = Object.fromEntries(withPolicy.map((i) => [i.id, i.action]));
    expect(byId.runPolicy).toEqual({ kind: 'link', href: '/policies/p%201/execute' });
    expect(byId.submitApproval).toEqual({ kind: 'link', href: '/policies/p%201/versions' });

    const without = buildGettingStartedItems({ signals: NONE, isAdmin: false, firstPolicyId: null });
    const byId2 = Object.fromEntries(without.map((i) => [i.id, i.action]));
    expect(byId2.runPolicy).toEqual({ kind: 'link', href: '/policies' });
    expect(byId2.submitApproval).toEqual({ kind: 'link', href: '/policies' });
  });

  it('Guard opens its how-to doc and preferences open the inline section', () => {
    const items = buildGettingStartedItems({ signals: NONE, isAdmin: false, firstPolicyId: null });
    const byId = Object.fromEntries(items.map((i) => [i.id, i.action]));
    expect(byId.connectGuard).toEqual({ kind: 'docs', slug: 'how-to/guard' });
    expect(byId.preferences).toEqual({ kind: 'preferences' });
  });
});

describe('summarizeGettingStarted', () => {
  it('counts only required items', () => {
    const items = buildGettingStartedItems({
      signals: { ...NONE, hasPreferences: true, hasPolicy: true, hasGuardDecision: true },
      isAdmin: false,
      firstPolicyId: 'p1',
    });
    expect(summarizeGettingStarted(items)).toEqual({ done: 1, total: 4, complete: false });
  });

  it('is complete when every required item is done, even if optional ones are not', () => {
    const items = buildGettingStartedItems({
      signals: { ...NONE, hasPolicy: true, hasRun: true, hasTeammate: true, hasSubmittedApproval: true },
      isAdmin: false,
      firstPolicyId: 'p1',
    });
    expect(summarizeGettingStarted(items)).toEqual({ done: 4, total: 4, complete: true });
  });

  it('admin completion matches the old launchpad: all five admin signals', () => {
    const all: GettingStartedSignals = {
      ...NONE,
      hasPolicy: true,
      hasApiKey: true,
      hasAiKey: true,
      hasTeammate: true,
      hasReviewedBilling: true,
    };
    const items = buildGettingStartedItems({ signals: all, isAdmin: true, firstPolicyId: null });
    expect(summarizeGettingStarted(items)).toEqual({ done: 5, total: 5, complete: true });
  });
});
