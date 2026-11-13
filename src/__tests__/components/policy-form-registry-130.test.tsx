import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { compileAndTypecheck } from '@aster-cloud/aster-lang-ts/browser';

/**
 * registry 1.3.0（ADR 0046 §11.4 ⑦）：eu-ai-act-high-risk 要求 verifiedInputs。
 * 编辑器用浏览器内置的 aster-lang-ts 编译；输入引用无法静态确定（inputRefs 为 ["*"]）的高风险规则
 * 必须报 E708 error 并禁用保存，与服务端 /compile 的保存门一致；字面路径规则与 governed 档案不受影响。
 * Monaco 用桩替换，但桩内走与 MonacoPolicyEditor 相同的真实引擎 + 诊断汇总 + 模块摘要。
 */

const h = vi.hoisted(() => ({ translate: vi.fn((key: string) => key), compiled: [] as string[][] }));

vi.mock('next/dynamic', async () => {
  const { collectCompileDiagnostics } = await import('@/hooks/useAsterCompiler');
  const { summarizeCoreModule } = await import('@/components/policy/core-module-summary');
  type StubProps = { value: string; onCompileChange?: (s: unknown) => void };
  // 与 MonacoPolicyEditor 上抛 onCompileChange 的映射同口径（severity / code / module 摘要）
  function EditorStub({ value, onCompileChange }: StubProps) {
    useEffect(() => {
      const result = compileAndTypecheck(value, {});
      const diagnostics = collectCompileDiagnostics(result, 'en-US').map((d) => ({
        severity: d.severity,
        message: d.message,
        code: d.code == null ? undefined : String(d.code),
        startLine: 1, startColumn: 1, endLine: 1, endColumn: 1,
      }));
      h.compiled.push(diagnostics.map((d) => d.code ?? ''));
      onCompileChange?.({ state: 'ok', diagnostics, module: summarizeCoreModule(result) });
    }, [value, onCompileChange]);
    return null;
  }
  return { __esModule: true, default: () => EditorStub };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/en/policies/p1/edit',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign(h.translate, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'en',
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/components/policy/policy-form/side-panel', () => ({ SidePanel: () => null }));
vi.mock('@/components/policy/policy-form/editor-palette', () => ({ EditorPalette: () => null }));
vi.mock('@/components/policy/policy-form/editor-rail', () => ({ EditorRail: () => null }));
vi.mock('@/components/policy/cnl-syntax-converter-dialog', () => ({ CNLSyntaxConverterDialog: () => null }));
vi.mock('@/components/policy/policy-form/use-is-mobile', () => ({ useIsMobile: () => false }));

import { PolicyForm } from '@/components/policy/policy-form';

/** 声明档案的模块：规则条件表达式由参数给出（动态 Map 键 → inputRefs ["*"]；字面字段 → 精确路径）。 */
function source(profile: string, condition: string): string {
  return `Module m.
Profile "${profile}".

Define Req has action as Text, meta as Map Text to Text.

@id("R-1")
@control("EU_AI_ACT:ART14")
Rule decide given req as Req, produce Verdict:
  If ${condition} equals to "x":
    Return Verdict.deny("d").
  Return Verdict.allow().
`;
}
const DYNAMIC = 'Map.get(req.meta, req.action)';
const EXACT = 'req.action';

function renderForm(content: string) {
  return render(
    <PolicyForm
      mode="edit"
      uiLocale="en"
      policyId="p1"
      initial={{ name: 'n', description: '', content, isPublic: false, groupId: null, aliasSet: null }}
      title="Edit"
      subtitle="s"
      onSave={vi.fn().mockResolvedValue({ id: 'p1' })}
      cancelHref="/en/policies/p1"
      detailHrefFor={(id) => `/en/policies/${id}`}
      breadcrumbs={[]}
    />,
  );
}

const saveButton = () => screen.getByRole('button', { name: 'save' }) as HTMLButtonElement;

describe('引擎：默认注册表 1.3.0 下的 E708', () => {
  const e708 = (src: string) =>
    (compileAndTypecheck(src, {}).typeErrors ?? []).filter((d) => String(d.code) === 'E708');

  it('★高风险档案 + 动态键规则 → 一条 E708 error', () => {
    const diags = e708(source('eu-ai-act-high-risk', DYNAMIC));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe('error');
    expect(diags[0].message).toContain("profile 'eu-ai-act-high-risk' requires verified inputs");
  });

  it('高风险档案 + 字面路径规则 → 无 E708', () => {
    expect(e708(source('eu-ai-act-high-risk', EXACT))).toEqual([]);
  });

  it('governed 档案 + 动态键规则 → 无 E708', () => {
    expect(e708(source('governed', DYNAMIC))).toEqual([]);
  });
});

describe('PolicyForm 保存门（registry 1.3.0）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.compiled.length = 0;
  });

  it('★高风险档案 + 动态键规则 → 保存禁用', async () => {
    renderForm(source('eu-ai-act-high-risk', DYNAMIC));
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(h.compiled.at(-1)).toEqual(['E708']);
    expect(saveButton().title).toBe('parseErrorsBeforeSaving');
  });

  it('高风险档案 + 字面路径规则 → 保存可用', async () => {
    renderForm(source('eu-ai-act-high-risk', EXACT));
    await waitFor(() => expect(h.compiled.length).toBeGreaterThan(0));
    expect(h.compiled.at(-1)).toEqual([]);
    expect(saveButton().disabled).toBe(false);
  });

  it('governed 档案 + 动态键规则 → 保存可用', async () => {
    renderForm(source('governed', DYNAMIC));
    await waitFor(() => expect(h.compiled.length).toBeGreaterThan(0));
    expect(h.compiled.at(-1)).toEqual([]);
    expect(saveButton().disabled).toBe(false);
  });
});
