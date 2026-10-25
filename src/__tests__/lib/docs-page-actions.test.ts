/**
 * Compile-time exhaustiveness for `PAGE_ACTIONS` is enforced by the
 * `Record<RouteSlug, PageActionSet>` annotation; this file pins a few
 * runtime invariants the type can't express.
 */

import { describe, it, expect } from 'vitest';
import { docsSidebar } from '@/lib/docs/sidebar';
import {
  PAGE_ACTIONS,
  canonicalTarget,
  getPageActions,
  pickAvailableActions,
  resolveAuditedAction,
  type RouteSlug,
} from '@/lib/docs/page-actions';
import type { DocsSessionAuth } from '@/lib/docs/use-docs-session';

// Compile-time assertion: `RouteSlug` must be a precise literal
// union, not `string`. We test this by asking whether `string` is
// assignable *to* `RouteSlug` — only true when RouteSlug has widened
// to string. The expected result is `false`, so this assignment
// fails to type-check if the literal-ness regresses.
//
// Note: a simple positive `'literal' extends RouteSlug ? true : false`
// also yields true when RouteSlug widens to `string`, so it cannot
// pin literal-ness. The negative form below is the discriminating
// assertion.
type _RouteSlug_IsLiteralUnion = string extends RouteSlug ? false : true;
const _routeSlugIsLiteral: _RouteSlug_IsLiteralUnion = true;
void _routeSlugIsLiteral;

describe('PAGE_ACTIONS registry', () => {
  it('covers every slug in docsSidebar', () => {
    const sidebarSlugs = docsSidebar.flatMap((s) => s.items.map((i) => i.href));
    for (const slug of sidebarSlugs) {
      expect(PAGE_ACTIONS, `missing registry entry for ${slug}`).toHaveProperty(slug);
    }
  });

  it('every action has a non-empty stable id and labelKey', () => {
    for (const [slug, set] of Object.entries(PAGE_ACTIONS)) {
      expect(set.primary.id, `primary id for ${slug}`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(set.primary.labelKey).toMatch(/^docs\.actions\./);
      for (const a of set.secondary ?? []) {
        expect(a.id).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(a.labelKey).toMatch(/^docs\.actions\./);
      }
    }
  });

  it('every action target is a relative path beginning with "/"', () => {
    for (const [slug, set] of Object.entries(PAGE_ACTIONS)) {
      expect(set.primary.href, `primary href for ${slug}`).toMatch(/^\//);
      for (const a of set.secondary ?? []) {
        expect(a.href, `secondary href for ${slug} / ${a.id}`).toMatch(/^\//);
      }
    }
  });

  it('every action passes ?from=docs so jump targets can attribute origin', () => {
    for (const [, set] of Object.entries(PAGE_ACTIONS)) {
      const all = [set.primary, ...(set.secondary ?? [])];
      for (const a of all) {
        expect(a.href).toContain('from=docs');
      }
    }
  });

  it('getPageActions returns null for unknown slugs', () => {
    expect(getPageActions('does/not/exist')).toBeNull();
  });

  it('getPageActions returns the same object as direct lookup', () => {
    const slug = 'api/policies/evaluate';
    expect(getPageActions(slug)).toBe(PAGE_ACTIONS[slug]);
  });

  it('canonicalTarget strips the query string', () => {
    expect(canonicalTarget(PAGE_ACTIONS['api/policies/evaluate'].primary)).toBe(
      '/policies/new',
    );
  });
});

describe('resolveAuditedAction (server-side registry binding)', () => {
  it('returns the matched action for a valid payload', () => {
    const matched = resolveAuditedAction({
      slug: 'api/policies/evaluate',
      cta_id: 'playground_evaluate',
      target: '/policies/new',
    });
    expect(matched?.id).toBe('playground_evaluate');
  });

  it('returns null when the slug is unknown', () => {
    expect(
      resolveAuditedAction({ slug: 'made/up', cta_id: 'x', target: '/' }),
    ).toBeNull();
  });

  it('returns null when the cta_id belongs to a different slug', () => {
    expect(
      resolveAuditedAction({
        slug: 'api/policies/evaluate',
        cta_id: 'view_my_audit_logs',
        target: '/security',
      }),
    ).toBeNull();
  });

  it('returns null when the target does not match the canonical path', () => {
    expect(
      resolveAuditedAction({
        slug: 'api/policies/evaluate',
        cta_id: 'playground_evaluate',
        target: '/policies/wrong',
      }),
    ).toBeNull();
  });
});

describe('pickAvailableActions', () => {
  const anonymous: DocsSessionAuth = {
    status: 'anonymous',
    capabilities: {
      canUsePlayground: true,
      canEditPolicies: false,
      canViewAudit: false,
      hasActiveTeam: false,
    },
  };

  it('probing 阶段不渲染任何动作', () => {
    const set = getPageActions('getting-started/quickstart')!;
    expect(pickAvailableActions(set, { status: 'probing' })).toEqual({
      primary: null,
      secondary: [],
    });
  });

  it('匿名访客按探针 capabilities 看到「在 Playground 试用」主动作（quickstart）', () => {
    const set = getPageActions('getting-started/quickstart')!;
    const { primary, secondary } = pickAvailableActions(set, anonymous);
    expect(primary?.labelKey).toBe('docs.actions.tryInPlayground');
    // public 次要动作（API Keys）同样保留
    expect(secondary.map((a) => a.id)).toEqual(['go_to_api_keys']);
  });

  it('匿名访客在 policies/evaluate 看到 Playground，但看不到需编辑权限的 Open in Editor', () => {
    const set = getPageActions('api/policies/evaluate')!;
    const { primary, secondary } = pickAvailableActions(set, anonymous);
    expect(primary?.labelKey).toBe('docs.actions.tryInPlayground');
    expect(secondary.some((a) => a.labelKey === 'docs.actions.openInEditor')).toBe(false);
  });

  it('探针收回 canUsePlayground 时匿名访客不再看到 Playground 主动作', () => {
    const set = getPageActions('api/policies/evaluate')!;
    const { primary } = pickAvailableActions(set, {
      ...anonymous,
      capabilities: { ...anonymous.capabilities, canUsePlayground: false },
    });
    expect(primary).toBeNull();
  });

  it('已登录且具备编辑权限时渲染 Open in Editor', () => {
    const set = getPageActions('api/policies/evaluate')!;
    const { primary, secondary } = pickAvailableActions(set, {
      status: 'authenticated',
      subjectHash: '0123456789abcdef',
      capabilities: {
        canUsePlayground: true,
        canEditPolicies: true,
        canViewAudit: true,
        hasActiveTeam: true,
      },
    });
    expect(primary?.labelKey).toBe('docs.actions.tryInPlayground');
    expect(secondary.map((a) => a.labelKey)).toContain('docs.actions.openInEditor');
  });
});
