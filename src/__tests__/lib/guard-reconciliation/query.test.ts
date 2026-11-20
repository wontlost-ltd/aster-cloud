// @vitest-environment node
// 孤儿列表查询解析（ADR 0061 §3.4 / Q3）：缺省 OPEN + critical,warning、50 条；severity=all 不过滤；非法 → null。
import { describe, it, expect } from 'vitest';
import { DEFAULT_ORPHAN_QUERY, orphanQueryToSearch, parseOrphanQuery } from '@/lib/guard-reconciliation/query';

const parse = (qs: string) => parseOrphanQuery(new URLSearchParams(qs));

describe('parseOrphanQuery', () => {
  it('空参数 → DEFAULT_ORPHAN_QUERY（OPEN + critical,warning，limit 50），且返回的是拷贝', () => {
    const q = parse('');
    expect(q).toEqual({ status: 'OPEN', severities: ['critical', 'warning'], limit: 50 });
    expect(q).toEqual(DEFAULT_ORPHAN_QUERY);
    q!.severities.push('info');
    expect(DEFAULT_ORPHAN_QUERY.severities).toEqual(['critical', 'warning']);
  });

  it('severity=all → 空数组，orphanQueryToSearch 不带 severity', () => {
    const q = parse('severity=all')!;
    expect(q.severities).toEqual([]);
    expect(orphanQueryToSearch(q).has('severity')).toBe(false);
    expect(orphanQueryToSearch(q).toString()).toBe('status=OPEN&limit=50');
  });

  it('多选保持给定顺序；其余参数按原值解析', () => {
    expect(parse('severity=info,critical')!.severities).toEqual(['info', 'critical']);
    expect(parse('status=ACKNOWLEDGED&kind=orphan_receipt&limit=200&before=123')).toEqual({
      status: 'ACKNOWLEDGED', severities: ['critical', 'warning'], kind: 'orphan_receipt', limit: 200, before: 123,
    });
  });

  it.each([
    'status=open', 'status=', 'severity=high', 'severity=', 'severity=critical,', 'severity=critical,critical',
    'severity=CRITICAL', 'severity=all,info', 'kind=x', 'kind=', 'limit=0', 'limit=201', 'limit=1.5', 'limit=01',
    'before=-1', 'before=0', 'before=1e3', 'before=99999999999999999', 'status=OPEN&status=RESOLVED',
    'severity=info&severity=critical',
  ])('非法 %s → null', (qs) => {
    expect(parse(qs)).toBeNull();
  });
});

describe('orphanQueryToSearch', () => {
  it('键序固定，多选以逗号连接（编码为 %2C）', () => {
    expect(orphanQueryToSearch(DEFAULT_ORPHAN_QUERY).toString()).toBe('status=OPEN&severity=critical%2Cwarning&limit=50');
    expect(orphanQueryToSearch({
      status: 'RESOLVED', severities: ['info'], kind: 'allow_unconsumed', limit: 10, before: 7,
    }).toString()).toBe('status=RESOLVED&severity=info&kind=allow_unconsumed&limit=10&before=7');
  });

  it('与 parseOrphanQuery 往返一致', () => {
    const q = parse('status=RESOLVED&severity=warning,info&kind=consumed_without_result&limit=5&before=42')!;
    expect(parseOrphanQuery(orphanQueryToSearch(q))).toEqual(q);
  });
});
