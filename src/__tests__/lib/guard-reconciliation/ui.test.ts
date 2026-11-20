/*
 * 对账页客户端辅助（ADR 0061 §3.7）：UTC 时间格式、BFF / 页面查询串（空 severity → `all`）、错误体解析。
 */
import { describe, it, expect } from 'vitest';
import { filterToSearch, formatUtc, orphanListUrl, readBffError, reconciliationPageHref } from '@/lib/guard-reconciliation/ui';

describe('guard-reconciliation ui helpers', () => {
  it('formatUtc 固定按 UTC 并标注；非法时间原样返回', () => {
    expect(formatUtc('2026-11-20T23:30:00Z', 'en')).toMatch(/Nov 20, 2026.*11:30:00\s?PM UTC$/);
    expect(formatUtc('not-a-date', 'en')).toBe('not-a-date');
  });

  it('filterToSearch：键序 status、severity、kind；空 severity 写 all（BFF 缺省是 critical,warning）', () => {
    expect(filterToSearch({ status: 'OPEN', severities: ['critical', 'warning'] }).toString())
      .toBe('status=OPEN&severity=critical%2Cwarning');
    expect(filterToSearch({ status: 'RESOLVED', severities: [], kind: 'orphan_receipt' }).toString())
      .toBe('status=RESOLVED&severity=all&kind=orphan_receipt');
  });

  it('orphanListUrl 编码租户并附游标；reconciliationPageHref 以 tenant 开头', () => {
    expect(orphanListUrl('a/b', { status: 'OPEN', severities: ['info'] }, 12))
      .toBe('/api/guard-reconciliation/a%2Fb?status=OPEN&severity=info&before=12');
    expect(reconciliationPageHref('team-1')).toBe('/governance/reconciliation?tenant=team-1');
    expect(reconciliationPageHref('team-1', { status: 'OPEN', severities: [] }))
      .toBe('/governance/reconciliation?tenant=team-1&status=OPEN&severity=all');
  });

  it('readBffError 取 error / requestId / status；体不可解析时退回响应头的 requestId', async () => {
    const body = new Response(JSON.stringify({ error: 'not_open', status: 'RESOLVED', requestId: 'r1' }), { status: 409 });
    expect(await readBffError(body)).toEqual({ httpStatus: 409, error: 'not_open', requestId: 'r1', status: 'RESOLVED' });
    const raw = new Response('oops', { status: 502, headers: { 'x-request-id': 'r2' } });
    expect(await readBffError(raw)).toEqual({ httpStatus: 502, error: undefined, requestId: 'r2', status: undefined });
  });
});
