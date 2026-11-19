// ADR 0058 §7.5 / 计划 T3：prepareLayout 的校验与错误码、layoutSaveErrorResponse 的响应形态（不连库）。
import { describe, expect, it } from 'vitest';

import { LAYOUT_ERROR_CASES, LAYOUT_SOURCE, LAYOUT_VALID_CASE } from '@/__tests__/fixtures/layout-error-cases';
import { LayoutSaveError, layoutSaveErrorResponse } from '@/lib/policy-layout/errors';
import { sha256Utf8Hex } from '@/lib/policy-layout/hash';
import { prepareLayout } from '@/lib/policy-layout/store';

const ctxOf = (input: { source: string; locale: string; aliasSet?: Record<string, string[]> }) => ({
  source: input.source,
  locale: input.locale,
  aliasSet: input.aliasSet ?? null,
});

function caught(fn: () => unknown): LayoutSaveError {
  try {
    fn();
  } catch (e) {
    if (e instanceof LayoutSaveError) return e;
    throw e;
  }
  throw new Error('期望抛出 LayoutSaveError');
}

describe('prepareLayout', () => {
  it.each(LAYOUT_ERROR_CASES.filter((c) => c.status === 400))('$name → $code', (c) => {
    const e = caught(() => prepareLayout(c.input.layout, ctxOf(c.input)));
    expect(e.code).toBe(c.code);
    expect(e.status).toBe(400);
    expect(e.detail).toEqual(c.expect);
  });

  it('accepts the valid control case', () => {
    const prepared = prepareLayout(LAYOUT_VALID_CASE.layout, ctxOf(LAYOUT_VALID_CASE));
    expect(prepared.sourceSha256).toBe(sha256Utf8Hex(LAYOUT_SOURCE));
    expect(prepared.layoutSha256).toBe(sha256Utf8Hex(prepared.serialized));
    expect(prepared.layoutSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['array', [{ v: 1, spans: [] }]],
    ['string', JSON.stringify(LAYOUT_VALID_CASE.layout)],
    ['number', 1],
  ])('%s input → layout_invalid_format', (_name, input) => {
    const e = caught(() => prepareLayout(input, ctxOf(LAYOUT_VALID_CASE)));
    expect(e.code).toBe('layout_invalid_format');
    expect(e.status).toBe(400);
  });

  it('unknown keys are rejected as layout_invalid_format', () => {
    const e = caught(() => prepareLayout({ ...(LAYOUT_VALID_CASE.layout as object), extra: 1 }, ctxOf(LAYOUT_VALID_CASE)));
    expect(e.code).toBe('layout_invalid_format');
  });

  it('serialization is deterministic and merges adjacent content spans', () => {
    const split = {
      v: 1,
      spans: [
        { text: 'Module demo' },
        { text: '.layout' },
        { canonical: '.\n\n', display: '\n' },
        { text: 'Rule decide given amount as Int, produce Int:\n' },
        { text: '  Return amount.\n' },
      ],
    };
    // 键序不同的同一 layout
    const reordered = { spans: split.spans.map((s) => ({ ...s })), v: 1 };
    const a = prepareLayout(split, ctxOf(LAYOUT_VALID_CASE));
    const b = prepareLayout(reordered, ctxOf(LAYOUT_VALID_CASE));
    const control = prepareLayout(LAYOUT_VALID_CASE.layout, ctxOf(LAYOUT_VALID_CASE));
    expect(a.serialized).toBe(b.serialized);
    expect(a.layoutSha256).toBe(b.layoutSha256);
    expect(a.serialized).toBe(control.serialized);
    expect(a.layout.spans).toHaveLength(3);
  });

  it('alias set decides whether a structural word is a keyword', () => {
    const source = 'Module demo.layout.\n\nRule decide given amount as Int, produce Int:\n  Let x gets amount.\n  Return x.\n';
    const input = {
      v: 1,
      spans: [
        { text: 'Module demo.layout.\n\nRule decide given amount as Int, produce Int:\n  Let x' },
        { canonical: ' gets ', display: ' = ' },
        { text: 'amount.\n  Return x.\n' },
      ],
    };
    expect(() => prepareLayout(input, { source, locale: 'en-US', aliasSet: { BE: ['gets'] } })).not.toThrow();
    expect(caught(() => prepareLayout(input, { source, locale: 'en-US', aliasSet: null })).code)
      .toBe('layout_structural_hides_value');
  });
});

describe('layoutSaveErrorResponse', () => {
  it.each(LAYOUT_ERROR_CASES)('$code → $status with code and detail', async (c) => {
    const res = layoutSaveErrorResponse(new LayoutSaveError(c.code, c.status, 'x', c.expect));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(c.status);
    expect(await res!.json()).toEqual({ error: 'x', code: c.code, ...c.expect });
  });

  it('returns null for other errors', () => {
    expect(layoutSaveErrorResponse(new Error('boom'))).toBeNull();
    expect(layoutSaveErrorResponse('nope')).toBeNull();
  });
});
