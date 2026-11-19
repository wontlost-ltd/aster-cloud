// layoutForCanonical：排版与调用处显示的 canonical 对不上时降为 inconsistent（ADR 0058 §7.2，计划 T7）。
import { describe, expect, it } from 'vitest';
import { layoutForCanonical } from '@/lib/policy-layout/reconcile';
import { LAYOUT_SOURCE, STORED_INCONSISTENT, STORED_OK } from '@/__tests__/fixtures/layout-read-fixture';

describe('layoutForCanonical', () => {
  it('ok 且往返等于 canonical：原样返回', () => {
    expect(layoutForCanonical(STORED_OK, LAYOUT_SOURCE)).toBe(STORED_OK);
  });

  it('ok 但 canonical 不同（含仅换行差异）：inconsistent，保留哈希', () => {
    const expected = { status: 'inconsistent', layoutSha256: (STORED_OK as { layoutSha256: string }).layoutSha256 };
    expect(layoutForCanonical(STORED_OK, LAYOUT_SOURCE + ' ')).toEqual(expected);
    expect(layoutForCanonical(STORED_OK, LAYOUT_SOURCE.replace(/\n/g, '\r\n'))).toEqual(expected);
  });

  it('none 与 inconsistent 原样返回', () => {
    expect(layoutForCanonical({ status: 'none' }, 'x')).toEqual({ status: 'none' });
    expect(layoutForCanonical(STORED_INCONSISTENT, 'x')).toBe(STORED_INCONSISTENT);
  });
});
