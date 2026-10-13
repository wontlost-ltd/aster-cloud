// Cron registry unit tests — window-bucket math + lookup invariants.
// No DB; pure functions.

import { describe, it, expect } from 'vitest';
import {
  CRON_REGISTRY,
  currentWindowStart,
  getCronByExpression,
  getCronByJobName,
} from '@/lib/cron-registry';

describe('CRON_REGISTRY invariants', () => {
  it('every job has a unique jobName', () => {
    const names = CRON_REGISTRY.map((c) => c.jobName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every job has a unique cron expression', () => {
    const exprs = CRON_REGISTRY.map((c) => c.cron);
    expect(new Set(exprs).size).toBe(exprs.length);
  });

  it('routePath always starts with /api/cron/', () => {
    for (const c of CRON_REGISTRY) {
      expect(c.routePath.startsWith('/api/cron/')).toBe(true);
    }
  });
});

describe('lookup helpers', () => {
  it('getCronByJobName / getCronByExpression are inverses', () => {
    for (const c of CRON_REGISTRY) {
      expect(getCronByJobName(c.jobName)?.cron).toBe(c.cron);
      expect(getCronByExpression(c.cron)?.jobName).toBe(c.jobName);
    }
  });

  it('returns undefined for unknown lookup', () => {
    expect(getCronByJobName('does-not-exist')).toBeUndefined();
    expect(getCronByExpression('99 99 * * *')).toBeUndefined();
  });

  it('currentWindowStart throws on unknown job', () => {
    expect(() => currentWindowStart('does-not-exist')).toThrow(/unknown jobName/);
  });
});

describe('window-start math (UTC)', () => {
  it('"30 4 * * *" snaps to today 04:30 UTC after that hour', () => {
    const now = new Date('2026-05-19T10:00:00.000Z');
    const w = currentWindowStart('user-purge', now);
    expect(w.toISOString()).toBe('2026-05-19T04:30:00.000Z');
  });

  it('"30 4 * * *" snaps to yesterday 04:30 UTC before that hour', () => {
    const now = new Date('2026-05-19T03:00:00.000Z');
    const w = currentWindowStart('user-purge', now);
    expect(w.toISOString()).toBe('2026-05-18T04:30:00.000Z');
  });

  it('"0 */6 * * *" snaps to the 6-hour bucket', () => {
    // 13:45 UTC → bucket 12:00 UTC
    const now = new Date('2026-05-19T13:45:00.000Z');
    const w = currentWindowStart('license-revocation-refresh', now);
    expect(w.toISOString()).toBe('2026-05-19T12:00:00.000Z');
  });

  it('"0 */6 * * *" boundary hour stays in its own bucket', () => {
    const now = new Date('2026-05-19T18:00:00.000Z');
    const w = currentWindowStart('license-revocation-refresh', now);
    expect(w.toISOString()).toBe('2026-05-19T18:00:00.000Z');
  });

  it('"0 8 * * 1" (Mon 08:00 UTC) snaps to the prior Monday from any weekday', () => {
    // 2026-05-19 is a Tuesday; the latest Monday 08:00 is 2026-05-18.
    const now = new Date('2026-05-19T10:00:00.000Z');
    const w = currentWindowStart('license-renewal-warning', now);
    expect(w.toISOString()).toBe('2026-05-18T08:00:00.000Z');
  });

  it('"0 8 * * 1" on Monday before 08:00 picks the previous Monday', () => {
    // 2026-05-18 06:00 UTC is Monday morning before 08:00.
    const now = new Date('2026-05-18T06:00:00.000Z');
    const w = currentWindowStart('license-renewal-warning', now);
    expect(w.toISOString()).toBe('2026-05-11T08:00:00.000Z');
  });

  it('"15 3 * * *" telemetry-retention-gc snaps to today 03:15 UTC after that hour', () => {
    const now = new Date('2026-05-19T05:00:00.000Z');
    const w = currentWindowStart('telemetry-retention-gc', now);
    expect(w.toISOString()).toBe('2026-05-19T03:15:00.000Z');
  });

  it('"25 * * * *" cleanup-nonces snaps to this hour :25 once past it', () => {
    const w = currentWindowStart('cleanup-nonces', new Date('2026-10-13T07:40:00.000Z'));
    expect(w.toISOString()).toBe('2026-10-13T07:25:00.000Z');
  });

  it('"25 * * * *" cleanup-nonces before :25 picks the previous hour (across midnight)', () => {
    const w = currentWindowStart('cleanup-nonces', new Date('2026-10-13T00:10:00.000Z'));
    expect(w.toISOString()).toBe('2026-10-12T23:25:00.000Z');
  });

  it('two calls inside the same bucket produce the same window-start', () => {
    const a = currentWindowStart('user-purge', new Date('2026-05-19T10:00:00.000Z'));
    const b = currentWindowStart('user-purge', new Date('2026-05-19T23:59:00.000Z'));
    expect(a.toISOString()).toBe(b.toISOString());
  });
});
