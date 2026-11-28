import { describe, expect, it } from 'vitest';

import { buildOrphanNotice, orphanNoticeHref, orphanNoticeId } from '@/lib/guard-orphan-notify/payload';
import type { OrphanFeedSummary } from '@/lib/guard-orphan-notify/feed-client';

const base: OrphanFeedSummary = {
  tenantId: 't-1',
  maxId: 42,
  total: 5,
  byKind: { side_effect_mismatch: 2, side_effect_unconsumed: 3 },
  firstDetectedAt: '2026-11-28T00:00:00Z',
  lastDetectedAt: '2026-11-28T01:00:00Z',
  runIds: [1, 2, 3],
};

describe('orphanNoticeId / orphanNoticeHref', () => {
  it('id 格式为 guard-orphans:<tenant>:<maxId>:<user>', () => {
    expect(orphanNoticeId('t-1', 42, 'u-9')).toBe('guard-orphans:t-1:42:u-9');
  });

  it('href 对租户 id 做编码', () => {
    expect(orphanNoticeHref('a b')).toBe('/governance/reconciliation?tenant=a%20b&severity=critical');
  });
});

describe('buildOrphanNotice', () => {
  it('payload is whitelisted', () => {
    const polluted = {
      ...base,
      detail: 'secret',
      executorId: 'exec',
      decisionId: 'dec',
      source: 'src',
      actionName: 'act',
    } as OrphanFeedSummary;
    const notice = buildOrphanNotice(polluted, 'Team A');
    expect(Object.keys(notice).sort()).toMatchInlineSnapshot(`
      [
        "byKind",
        "firstDetectedAt",
        "lastDetectedAt",
        "maxOrphanId",
        "newTotal",
        "runIds",
        "tenantId",
        "tenantName",
      ]
    `);
    expect(notice).toEqual({
      tenantId: 't-1',
      tenantName: 'Team A',
      newTotal: 5,
      byKind: { side_effect_mismatch: 2, side_effect_unconsumed: 3 },
      firstDetectedAt: '2026-11-28T00:00:00Z',
      lastDetectedAt: '2026-11-28T01:00:00Z',
      maxOrphanId: 42,
      runIds: [1, 2, 3],
    });
  });

  it('unknown critical kind counted as other', () => {
    const notice = buildOrphanNotice({ ...base, byKind: { side_effect_mismatch: 2, future_kind: 3 } }, '');
    expect(notice.byKind).toEqual({ side_effect_mismatch: 2, other: 3 });
  });

  it('非 critical 的已知 kind 也归入 other 并累加', () => {
    const notice = buildOrphanNotice(
      { ...base, byKind: { allow_unconsumed: 1, future_kind: 3, orphan_receipt: 2 } },
      '',
    );
    expect(notice.byKind).toEqual({ other: 6 });
  });

  it('无 other 时不写 other 键', () => {
    expect(buildOrphanNotice(base, '').byKind).not.toHaveProperty('other');
  });

  it('runIds 截断到 8', () => {
    const notice = buildOrphanNotice({ ...base, runIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, '');
    expect(notice.runIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('不改写输入的 runIds / byKind', () => {
    const input = { ...base, runIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] };
    buildOrphanNotice(input, '');
    expect(input.runIds).toHaveLength(9);
  });

  it('缺少 firstDetectedAt 或 lastDetectedAt 时抛错', () => {
    expect(() => buildOrphanNotice({ ...base, firstDetectedAt: undefined }, '')).toThrow();
    expect(() => buildOrphanNotice({ ...base, lastDetectedAt: undefined }, '')).toThrow();
  });
});
