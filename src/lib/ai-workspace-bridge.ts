/**
 * 策略编辑器与 AI 工作台 iframe 之间的 postMessage 协议（ADR 0049 §2.5）。
 * 纯函数，便于测试；只认工作台 origin 与当前策略 id，其余消息一律丢弃。
 */
export type ApplyMessage = {
  type: 'aster.ai.apply';
  v: 1;
  action: 'insert' | 'replace';
  code: string;
  policyId: string;
  requestId: string;
};
export type BridgeIn = { type: 'aster.ai.ready'; v: 1 } | ApplyMessage | { type: 'aster.ai.reauth'; v: 1 };

/** 只取 Monaco 编辑器上本协议用到的结构，测试可用普通对象替身。 */
export type EditorLike = {
  getModel(): { getFullModelRange(): unknown } | null;
  getSelection(): unknown | null;
  executeEdits(src: string, edits: { range: unknown; text: string; forceMoveMarkers?: boolean }[]): boolean;
  focus(): void;
  getValue(): string;
};

export type ApplyResult = { ok: true } | { ok: false; reason: 'policy_mismatch' | 'no_editor' };

const MAX_CODE = 65_536;
const DOC_START = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
const isStr = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function parseApply(d: Record<string, unknown>): ApplyMessage | null {
  const okAction = d.action === 'insert' || d.action === 'replace';
  const okCode = typeof d.code === 'string' && d.code.length <= MAX_CODE;
  if (!okAction || !okCode || !isStr(d.policyId, 64) || !isStr(d.requestId, 64)) return null;
  // 重新组装对象，丢弃对端附带的任何额外字段；code 原样保留（含结尾换行）。
  return {
    type: 'aster.ai.apply',
    v: 1,
    action: d.action as ApplyMessage['action'],
    code: d.code as string,
    policyId: d.policyId as string,
    requestId: d.requestId as string,
  };
}

/** 校验来源与形状：origin 不符、版本不符、类型未知、字段缺失或 code 超长时返回 null。 */
export function parseBridgeMessage(ev: { origin: string; data: unknown }, expectedOrigin: string): BridgeIn | null {
  if (ev.origin !== expectedOrigin || typeof ev.data !== 'object' || ev.data === null) return null;
  const d = ev.data as Record<string, unknown>;
  if (d.v !== 1) return null;
  if (d.type === 'aster.ai.ready' || d.type === 'aster.ai.reauth') return { type: d.type, v: 1 };
  return d.type === 'aster.ai.apply' ? parseApply(d) : null;
}

/** 把工作台给出的代码写回编辑器：insert 落在当前选区（无选区则文首），replace 覆盖全文。 */
export function applyToEditor(editor: EditorLike | null, msg: ApplyMessage, currentPolicyId: string): ApplyResult {
  // 面板与编辑器策略不一致（如切换策略后旧 iframe 迟到的消息）时拒绝写入。
  if (msg.policyId !== currentPolicyId) return { ok: false, reason: 'policy_mismatch' };
  const model = editor?.getModel();
  if (!editor || !model) return { ok: false, reason: 'no_editor' };
  if (msg.action === 'replace') {
    editor.executeEdits('ai-workspace-replace', [{ range: model.getFullModelRange(), text: msg.code }]);
  } else {
    const range = editor.getSelection() ?? DOC_START;
    editor.executeEdits('ai-workspace-insert', [{ range, text: msg.code, forceMoveMarkers: true }]);
  }
  editor.focus();
  return { ok: true };
}

/** 向工作台推送当前策略上下文（源码与 CNL 语言）。 */
export function contextMessage(policyId: string, source: string, cnlLocale: string) {
  return { type: 'aster.ai.context' as const, v: 1 as const, policyId, source, cnlLocale };
}
