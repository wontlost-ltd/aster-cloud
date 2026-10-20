import { describe, expect, it, vi } from 'vitest';
import { applyToEditor, contextMessage, parseBridgeMessage } from '@/lib/ai-workspace-bridge';

const ORIGIN = 'https://ai.aster-lang.cloud';
const apply = (over: object = {}) => ({ type: 'aster.ai.apply', v: 1, action: 'insert', code: 'Rule a.', policyId: 'p1', requestId: 'r1', ...over });
function editor() {
  return {
    getModel: () => ({ getFullModelRange: () => 'FULL' }),
    getSelection: () => 'SEL',
    executeEdits: vi.fn(() => true),
    focus: vi.fn(),
    getValue: () => 'Rule a.',
  };
}

describe('parseBridgeMessage', () => {
  it('只接受工作台 origin', () => {
    expect(parseBridgeMessage({ origin: 'https://evil.example', data: apply() }, ORIGIN)).toBeNull();
    expect(parseBridgeMessage({ origin: ORIGIN, data: apply() }, ORIGIN)).toMatchObject({ type: 'aster.ai.apply' });
  });
  it('版本、类型、字段不合法一律忽略', () => {
    expect(parseBridgeMessage({ origin: ORIGIN, data: apply({ v: 2 }) }, ORIGIN)).toBeNull();
    expect(parseBridgeMessage({ origin: ORIGIN, data: { type: 'aster.ai.unknown', v: 1 } }, ORIGIN)).toBeNull();
    expect(parseBridgeMessage({ origin: ORIGIN, data: apply({ action: 'delete' }) }, ORIGIN)).toBeNull();
    expect(parseBridgeMessage({ origin: ORIGIN, data: apply({ code: 'x'.repeat(65_537) }) }, ORIGIN)).toBeNull();
    expect(parseBridgeMessage({ origin: ORIGIN, data: 'string' }, ORIGIN)).toBeNull();
  });
  it('缺字段一律忽略；ready/reauth 只保留协议字段', () => {
    expect(parseBridgeMessage({ origin: ORIGIN, data: apply({ requestId: undefined }) }, ORIGIN)).toBeNull();
    expect(parseBridgeMessage({ origin: ORIGIN, data: apply({ policyId: '' }) }, ORIGIN)).toBeNull();
    expect(parseBridgeMessage({ origin: ORIGIN, data: apply({ code: 42 }) }, ORIGIN)).toBeNull();
    expect(parseBridgeMessage({ origin: ORIGIN, data: null }, ORIGIN)).toBeNull();
    expect(parseBridgeMessage({ origin: ORIGIN, data: { type: 'aster.ai.ready', v: 1, extra: 1 } }, ORIGIN)).toEqual({ type: 'aster.ai.ready', v: 1 });
    expect(parseBridgeMessage({ origin: ORIGIN, data: { type: 'aster.ai.reauth', v: 1 } }, ORIGIN)).toEqual({ type: 'aster.ai.reauth', v: 1 });
  });
  it('code 原样保留（含结尾换行）', () => {
    expect(parseBridgeMessage({ origin: ORIGIN, data: apply({ code: 'Rule a.\n' }) }, ORIGIN)).toMatchObject({ code: 'Rule a.\n' });
  });
});

describe('applyToEditor', () => {
  it('insert 写在选区', () => {
    const ed = editor();
    expect(applyToEditor(ed, apply() as never, 'p1')).toEqual({ ok: true });
    expect(ed.executeEdits).toHaveBeenCalledWith('ai-workspace-insert', [{ range: 'SEL', text: 'Rule a.', forceMoveMarkers: true }]);
    expect(ed.focus).toHaveBeenCalled();
  });
  it('无选区时插入到 1,1', () => {
    const ed = { ...editor(), getSelection: () => null };
    applyToEditor(ed, apply() as never, 'p1');
    expect(ed.executeEdits).toHaveBeenCalledWith('ai-workspace-insert', [
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'Rule a.', forceMoveMarkers: true },
    ]);
  });
  it('replace 覆盖全文', () => {
    const ed = editor();
    applyToEditor(ed, apply({ action: 'replace' }) as never, 'p1');
    expect(ed.executeEdits).toHaveBeenCalledWith('ai-workspace-replace', [{ range: 'FULL', text: 'Rule a.' }]);
  });
  it('policyId 不一致：不改编辑器', () => {
    const ed = editor();
    expect(applyToEditor(ed, apply({ policyId: 'other' }) as never, 'p1')).toEqual({ ok: false, reason: 'policy_mismatch' });
    expect(ed.executeEdits).not.toHaveBeenCalled();
  });
  it('编辑器缺失或无 model：no_editor', () => {
    expect(applyToEditor(null, apply() as never, 'p1')).toEqual({ ok: false, reason: 'no_editor' });
    const ed = { ...editor(), getModel: () => null };
    expect(applyToEditor(ed, apply() as never, 'p1')).toEqual({ ok: false, reason: 'no_editor' });
    expect(ed.executeEdits).not.toHaveBeenCalled();
  });
});

describe('contextMessage', () => {
  it('形状固定', () => {
    expect(contextMessage('p1', 'src', 'zh')).toEqual({ type: 'aster.ai.context', v: 1, policyId: 'p1', source: 'src', cnlLocale: 'zh' });
  });
});
