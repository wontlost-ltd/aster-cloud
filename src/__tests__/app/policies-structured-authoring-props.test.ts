// 编辑器页（新建 / 编辑）服务端解析 structured_authoring 并把结果传给内容组件（ADR 0058 §4.10）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resolve: vi.fn(),
  newProps: null as null | Record<string, unknown>,
  editProps: null as null | Record<string, unknown>,
  policyTeamId: 'team-9' as string | null,
}));

vi.mock('@/lib/auth', () => ({ getSession: async () => ({ user: { id: 'u1' } }) }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));
vi.mock('@/lib/page-metadata', () => ({ localizedTitle: () => async () => ({}) }));
vi.mock('@/lib/structural-alias-grants', () => ({ getStructuralAliasGrant: async () => false }));
vi.mock('@/lib/capabilities/resolve', () => ({ resolveEntitlementForRequest: h.resolve }));
vi.mock('@/lib/policy-freeze', () => ({ isPolicyFrozen: async () => ({ isFrozen: false }) }));
vi.mock('@/lib/policy-version-locale', () => ({ resolveStoredVersionLocale: () => null }));
vi.mock('@/lib/policy-access', () => ({
  loadPolicyForAction: async () => ({
    ok: true,
    policy: {
      id: 'p1',
      name: 'n',
      description: null,
      content: 'c',
      isPublic: false,
      groupId: null,
      version: 1,
      userId: 'u1',
      teamId: h.policyTeamId,
    },
  }),
  authorizePolicyAction: async () => ({ allowed: true }),
}));
vi.mock('@/lib/prisma', () => ({
  db: { query: { policyVersions: { findFirst: async () => null } } },
  policyVersions: {},
}));
vi.mock('@/app/[locale]/(dashboard)/policies/new/new-policy-content', () => ({
  NewPolicyContent: (props: Record<string, unknown>) => {
    h.newProps = props;
    return null;
  },
}));
vi.mock('@/app/[locale]/(dashboard)/policies/[id]/edit/edit-policy-content', () => ({
  EditPolicyContent: (props: Record<string, unknown>) => {
    h.editProps = props;
    return null;
  },
}));

import NewPolicyPage from '@/app/[locale]/(dashboard)/policies/new/page';
import EditPolicyPage from '@/app/[locale]/(dashboard)/policies/[id]/edit/page';

const ENTITLEMENT = { allowed: true, sources: [{ kind: 'direct', grantId: 'g1' }] };

/** 页面是 async 服务端组件：直接调用拿到元素，元素的 props 即内容组件入参。 */
async function renderNew(sp: Record<string, string | string[] | undefined>) {
  const el = (await NewPolicyPage({ params: Promise.resolve({ locale: 'zh' }), searchParams: Promise.resolve(sp) })) as {
    props: Record<string, unknown>;
  };
  return el.props;
}

async function renderEdit() {
  const el = (await EditPolicyPage({ params: Promise.resolve({ id: 'p1', locale: 'zh' }) })) as {
    props: Record<string, unknown>;
  };
  return el.props;
}

beforeEach(() => {
  h.resolve.mockReset();
  h.resolve.mockResolvedValue(ENTITLEMENT);
  h.policyTeamId = 'team-9';
});

describe('编辑页 structuredAuthoring', () => {
  it('团队策略按策略所属团队解析', async () => {
    const props = await renderEdit();
    expect(h.resolve).toHaveBeenCalledWith('u1', 'structured_authoring', { teamId: 'team-9' });
    expect(props.structuredAuthoring).toEqual(ENTITLEMENT);
  });

  it('个人策略 teamId 为 null', async () => {
    h.policyTeamId = null;
    await renderEdit();
    expect(h.resolve).toHaveBeenCalledWith('u1', 'structured_authoring', { teamId: null });
  });
});

describe('新建页 structuredAuthoring', () => {
  it('?teamId=t1 时传 t1', async () => {
    const props = await renderNew({ teamId: 't1' });
    expect(h.resolve).toHaveBeenCalledWith('u1', 'structured_authoring', { teamId: 't1' });
    expect(props.structuredAuthoring).toEqual(ENTITLEMENT);
  });

  it('无 teamId 时传 null', async () => {
    await renderNew({});
    expect(h.resolve).toHaveBeenCalledWith('u1', 'structured_authoring', { teamId: null });
  });

  it('teamId 重复出现（数组）时取第一个，与客户端 searchParams.get 一致', async () => {
    await renderNew({ teamId: ['a', 'b'] });
    expect(h.resolve).toHaveBeenCalledWith('u1', 'structured_authoring', { teamId: 'a' });
  });

  it('teamId 为空串时传 null', async () => {
    await renderNew({ teamId: '' });
    expect(h.resolve).toHaveBeenCalledWith('u1', 'structured_authoring', { teamId: null });
  });

  it('数组首项为空串时传 null', async () => {
    await renderNew({ teamId: ['', 'b'] });
    expect(h.resolve).toHaveBeenCalledWith('u1', 'structured_authoring', { teamId: null });
  });
});

describe('无权时不下发授权来源（ADR §5.1）', () => {
  const DENIED_WITH_SOURCES = {
    allowed: false,
    denial: 'plan_required',
    sources: [{ kind: 'team', grantId: 'g2', teamId: 'team-9' }],
  };

  it('新建页：保留 allowed / denial，sources 为空', async () => {
    h.resolve.mockResolvedValue(DENIED_WITH_SOURCES);
    const props = await renderNew({});
    expect(props.structuredAuthoring).toEqual({ allowed: false, denial: 'plan_required', sources: [] });
  });

  it('编辑页：保留 allowed / denial，sources 为空', async () => {
    h.resolve.mockResolvedValue(DENIED_WITH_SOURCES);
    const props = await renderEdit();
    expect(props.structuredAuthoring).toEqual({ allowed: false, denial: 'plan_required', sources: [] });
  });

  it('有权时 sources 原样下发', async () => {
    const props = await renderEdit();
    expect(props.structuredAuthoring).toEqual(ENTITLEMENT);
  });
});
