/**
 * 只读视图测试共用的版本源码与显示排版（ADR 0058 P2 T7/T8）。
 * 一个结构 span 改写为中文、一个结构 span 的 display 为空（插入标记）、一个内容 span 含 emoji（代理对）。
 */
import { serializeLayout, toCanonical, toDisplay, type PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import { createHash } from 'node:crypto';
import type { StoredLayout } from '@/lib/policy-layout/types';

export const LAYOUT_SOURCE = 'Module m.\n\nRule decide given x: Int, produce Int:\n  Return x. // 🙂\n';

export const LAYOUT: PolicyLayout = {
  v: 1,
  spans: [
    { canonical: 'Module ', display: '模块 ' },
    { text: 'm.\n\n' },
    { canonical: 'Rule ', display: '' },
    { text: 'decide given x: Int, produce Int:\n  ' },
    { canonical: 'Return ', display: '返回 ' },
    { text: 'x. // 🙂\n' },
  ],
};

export const LAYOUT_DISPLAY = toDisplay(LAYOUT);

export function layoutSha(layout: PolicyLayout): string {
  return createHash('sha256').update(serializeLayout(layout), 'utf8').digest('hex');
}

export const STORED_OK: StoredLayout = { status: 'ok', layout: LAYOUT, layoutSha256: layoutSha(LAYOUT) };
export const STORED_INCONSISTENT: StoredLayout = { status: 'inconsistent', layoutSha256: layoutSha(LAYOUT) };

if (toCanonical(LAYOUT) !== LAYOUT_SOURCE) throw new Error('fixture: layout 与源码不往返');
