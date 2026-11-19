// 词汇规范预览窗格（ADR 0058 §8.2–8.3）：按 mappings 映射光标、请求失败或返回 null 时显示不可用、
// 不可见与双向控制字符可见化（aster-api#562 对 Task 14 的修订）。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import zhBase from '@aster-cloud/ui-messages/zh-CN.json';

/** 假的只读 Monaco：按 value 计算行列，记录选区与装饰。 */
const previewEditors = vi.hoisted(() => [] as Array<ReturnType<typeof makePreviewEditor>>);
function makePreviewEditor(getValue: () => string) {
  const positionAt = (offset: number) => {
    const before = getValue().slice(0, offset).split('\n');
    return { lineNumber: before.length, column: before[before.length - 1].length + 1 };
  };
  return {
    getModel: () => ({ getPositionAt: positionAt }),
    setSelection: vi.fn(),
    revealRangeInCenterIfOutsideViewport: vi.fn(),
    createDecorationsCollection: vi.fn(() => ({ clear: vi.fn() })),
  };
}
vi.mock('@monaco-editor/react', () => ({
  default: function FakeEditor(props: { value: string; options: Record<string, unknown>; onMount?: (ed: unknown) => void }) {
    const { value, onMount } = props;
    useEffect(() => {
      const ed = makePreviewEditor(() => value);
      previewEditors.push(ed);
      onMount?.(ed);
      // 只在挂载时回调一次，与 @monaco-editor/react 一致
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <pre data-testid="preview-monaco" data-options={JSON.stringify(props.options)}>{value}</pre>;
  },
}));

import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import { CanonicalPreviewPane } from '@/components/policy/policy-form/canonical-preview-pane';
import {
  HIDDEN_CHAR_PLACEHOLDER,
  mapSourceOffsetToPreview,
  parseCanonicalPreview,
  revealHiddenChars,
  type CanonicalPreview,
} from '@/lib/structured-authoring/canonical-preview';

const messages = deepMergeMessages(zhBase as Record<string, unknown>, DEMO_SUPPLEMENT.zh) as {
  policyEditor: { canonicalPreview: Record<string, string> };
};
const M = messages.policyEditor.canonicalPreview;

// de-DE：「Fahrer」→「Driver」（等长），「alter」→「age」（短 2）
const SOURCE = 'Definiere Fahrer mit alter.\nGib alter zurück.';
const PREVIEW: CanonicalPreview = {
  text: 'Definiere Driver mit age.\nGib age zurück.',
  mappings: [
    { source: [10, 16], preview: [10, 16], canonical: 'Driver', role: 'TYPE' },
    { source: [21, 26], preview: [21, 24], canonical: 'age', role: 'FIELD' },
    { source: [32, 37], preview: [30, 33], canonical: 'age', role: 'FIELD' },
  ],
  resolverVersion: 1,
};

function sourceEditor(text = SOURCE) {
  let listener: (() => void) | null = null;
  const state = { offset: 0, text };
  return {
    state,
    getModel: () => ({ getValue: () => state.text, getOffsetAt: () => state.offset }),
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    onDidChangeCursorPosition: vi.fn((cb: () => void) => {
      listener = cb;
      return { dispose: vi.fn() };
    }),
    moveTo(offset: number) {
      state.offset = offset;
      listener?.();
    },
  };
}

function pane(props: { editor: ReturnType<typeof sourceEditor> | null; request: () => Promise<CanonicalPreview | null>; source?: string }) {
  return (
    <IntlClientProvider locale="zh" messages={messages as never}>
      <CanonicalPreviewPane
        editor={props.editor as never}
        source={props.source ?? SOURCE}
        request={props.request}
        onClose={() => {}}
      />
    </IntlClientProvider>
  );
}

const lastSelection = () => {
  const ed = previewEditors[previewEditors.length - 1];
  return ed.setSelection.mock.calls[ed.setSelection.mock.calls.length - 1]?.[0];
};

afterEach(() => {
  cleanup();
  previewEditors.length = 0;
});

describe('mapSourceOffsetToPreview', () => {
  it('落在被替换 token 内部：选中整个预览区间', () => {
    expect(mapSourceOffsetToPreview(PREVIEW.mappings, 23)).toEqual([21, 24]);
    expect(mapSourceOffsetToPreview(PREVIEW.mappings, 11)).toEqual([10, 16]);
  });

  it('token 之外：按此前替换的长度差累计平移', () => {
    expect(mapSourceOffsetToPreview(PREVIEW.mappings, 5)).toEqual([5, 5]);
    // 「alter」之后（第一行句点）：少 2
    expect(mapSourceOffsetToPreview(PREVIEW.mappings, 26)).toEqual([24, 24]);
    // 第二行「zurück」内：两次替换各少 2
    expect(mapSourceOffsetToPreview(PREVIEW.mappings, 40)).toEqual([36, 36]);
  });

  it('token 边界算 token 外（光标停在词前 / 词后）', () => {
    expect(mapSourceOffsetToPreview(PREVIEW.mappings, 21)).toEqual([21, 21]);
    expect(mapSourceOffsetToPreview(PREVIEW.mappings, 37)).toEqual([33, 33]);
  });

  it('无 mappings 时原样', () => {
    expect(mapSourceOffsetToPreview([], 7)).toEqual([7, 7]);
  });
});

describe('parseCanonicalPreview', () => {
  it('合契约的响应原样返回，其余为 null', () => {
    expect(parseCanonicalPreview(PREVIEW)).toBe(PREVIEW);
    expect(parseCanonicalPreview(null)).toBeNull();
    expect(parseCanonicalPreview({ text: 'x', mappings: [], resolverVersion: '1' })).toBeNull();
    expect(parseCanonicalPreview({ text: 'x', mappings: [{ source: [2, 1], preview: [0, 0], canonical: 'a', role: 'r' }], resolverVersion: 1 })).toBeNull();
  });
});

describe('revealHiddenChars', () => {
  it('双向覆盖与零宽字符换成等长占位并列出码位，Tab / 换行保留', () => {
    const text = 'Gib "‮abc​" zurück.\n\tok';
    const { display, hidden } = revealHiddenChars(text);
    expect(display.length).toBe(text.length);
    expect(display).not.toMatch(/[‮​]/);
    expect(display).toContain(`"${HIDDEN_CHAR_PLACEHOLDER}abc${HIDDEN_CHAR_PLACEHOLDER}"`);
    expect(display).toContain('\n\tok');
    expect(hidden.map((h) => h.codePoint)).toEqual(['U+202E', 'U+200B']);
    expect(hidden[0].offset).toBe(text.indexOf('‮'));
  });

  it('代理对上的格式字符按 UTF-16 长度替换，偏移不变', () => {
    const tag = '\u{E0041}';
    const { display, hidden } = revealHiddenChars(`a${tag}b`);
    expect(hidden).toEqual([{ offset: 1, length: 2, codePoint: 'U+E0041' }]);
    expect(display).toBe(`a${HIDDEN_CHAR_PLACEHOLDER.repeat(2)}b`);
  });

  it('普通文本不变', () => {
    expect(revealHiddenChars('Fahrer 😀 「ja」')).toEqual({ display: 'Fahrer 😀 「ja」', hidden: [] });
  });
});

describe('CanonicalPreviewPane', () => {
  it('显示预览文本，只读并开启控制字符渲染', async () => {
    render(pane({ editor: sourceEditor(), request: () => Promise.resolve(PREVIEW) }));
    const monaco = await screen.findByTestId('preview-monaco');
    expect(monaco.textContent).toBe(PREVIEW.text);
    const options = JSON.parse(monaco.getAttribute('data-options') ?? '{}');
    expect(options.readOnly).toBe(true);
    expect(options.renderControlCharacters).toBe(true);
    expect(options.unicodeHighlight.invisibleCharacters).toBe(true);
  });

  it('源码光标落在被替换 token 内：选中其整个预览区间', async () => {
    const ed = sourceEditor();
    render(pane({ editor: ed, request: () => Promise.resolve(PREVIEW) }));
    await screen.findByTestId('preview-monaco');
    // 光标同步订阅完成时会先同步一次当前光标
    await waitFor(() => expect(previewEditors[0]?.setSelection).toHaveBeenCalled());
    act(() => ed.moveTo(33)); // 第二行「alter」内
    expect(lastSelection()).toEqual({ startLineNumber: 2, startColumn: 5, endLineNumber: 2, endColumn: 8 });
  });

  it('源码光标在 token 外：按累计偏移落到对应位置', async () => {
    const ed = sourceEditor();
    render(pane({ editor: ed, request: () => Promise.resolve(PREVIEW) }));
    await screen.findByTestId('preview-monaco');
    // 光标同步订阅完成时会先同步一次当前光标
    await waitFor(() => expect(previewEditors[0]?.setSelection).toHaveBeenCalled());
    act(() => ed.moveTo(40)); // 第二行「zurück」内
    expect(lastSelection()).toEqual({ startLineNumber: 2, startColumn: 11, endLineNumber: 2, endColumn: 11 });
  });

  it('编辑器内容已不是生成预览时的内容：不映射（偏移已失效）', async () => {
    const ed = sourceEditor();
    render(pane({ editor: ed, request: () => Promise.resolve(PREVIEW) }));
    await screen.findByTestId('preview-monaco');
    await waitFor(() => expect(previewEditors[0]?.setSelection).toHaveBeenCalled());
    const calls = previewEditors[0].setSelection.mock.calls.length;
    ed.state.text = `${SOURCE} `;
    act(() => ed.moveTo(33));
    expect(previewEditors[0].setSelection.mock.calls.length).toBe(calls);
  });

  it('请求返回 null：显示不可用文案', async () => {
    render(pane({ editor: sourceEditor(), request: () => Promise.resolve(null) }));
    expect(await screen.findByText(M.unavailable)).toBeTruthy();
    expect(screen.queryByTestId('preview-monaco')).toBeNull();
  });

  it('请求失败：显示不可用文案，不抛错', async () => {
    render(pane({ editor: sourceEditor(), request: () => Promise.reject(new Error('WebSocket not connected')) }));
    expect(await screen.findByText(M.unavailable)).toBeTruthy();
  });

  it('请求进行中显示加载文案', () => {
    render(pane({ editor: sourceEditor(), request: () => new Promise(() => {}) }));
    expect(screen.getByText(M.loading)).toBeTruthy();
  });

  it('源码变化时重新请求，只采用最后一次的结果', async () => {
    let resolveFirst: (p: CanonicalPreview | null) => void = () => {};
    const request = vi
      .fn<() => Promise<CanonicalPreview | null>>()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => Promise.resolve(PREVIEW));
    const ed = sourceEditor();
    const { rerender } = render(pane({ editor: ed, request }));
    rerender(pane({ editor: ed, request, source: `${SOURCE}\n` }));
    expect(await screen.findByTestId('preview-monaco')).toBeTruthy();
    await act(async () => resolveFirst(null));
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(M.unavailable)).toBeNull();
    expect(screen.getByTestId('preview-monaco').textContent).toBe(PREVIEW.text);
  });

  it('不可见与双向控制字符可见化：Monaco 拿不到原字符，窗格列出码位并加装饰', async () => {
    const text = 'Gib "‮abc" zurück.';
    render(pane({ editor: sourceEditor(), request: () => Promise.resolve({ text, mappings: [], resolverVersion: 1 }) }));
    const monaco = await screen.findByTestId('preview-monaco');
    expect(monaco.textContent).not.toContain('‮');
    expect(monaco.textContent).toContain(HIDDEN_CHAR_PLACEHOLDER);
    expect(screen.getByTestId('canonical-preview-hidden-chars').textContent).toContain('U+202E');
    await waitFor(() => expect(previewEditors[0]?.createDecorationsCollection).toHaveBeenCalled());
    const [decorations] = previewEditors[0].createDecorationsCollection.mock.calls[0] as unknown as [Array<{ range: unknown; options: { hoverMessage: { value: string } } }>];
    expect(decorations).toHaveLength(1);
    expect(decorations[0].range).toEqual({ startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 7 });
    expect(decorations[0].options.hoverMessage.value).toBe('U+202E');
  });

  it('无控制字符时不显示提示', async () => {
    render(pane({ editor: sourceEditor(), request: () => Promise.resolve(PREVIEW) }));
    await screen.findByTestId('preview-monaco');
    expect(screen.queryByTestId('canonical-preview-hidden-chars')).toBeNull();
  });
});
