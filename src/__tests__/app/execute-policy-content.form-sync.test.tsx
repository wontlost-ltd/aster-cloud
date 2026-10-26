// 执行页表单 / JSON 单一状态源与数字输入无障碍属性（#635），以及枚举结果的展示（#633）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => `${ns ?? ''}.${key}`,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/use-deployment-mode', () => ({
  CLIENT_CAPABILITIES: {
    billing: true, pricing: true, riskTier: false, dunning: false,
    signup: true, mixpanel: false, resend: false, license: false, sso: false,
  },
}));

// 德语策略：person 为结构（整数 alter、枚举 niveau）、faktor 为小数参数。
const PARAMETERS = [
  {
    name: 'person', type: 'Fahrer', typeKind: 'struct',
    fields: [
      { name: 'alter', type: 'Ganzzahl', typeKind: 'primitive' },
      { name: 'niveau', type: 'Stufe', typeKind: 'enum', enumVariants: ['Hoch', 'Niedrig'] },
    ],
  },
  { name: 'faktor', type: 'Dezimal', typeKind: 'primitive' },
];
vi.mock('@aster-cloud/aster-lang-ts/browser', () => ({
  extractSchema: () => ({ success: true, functionName: 'einstufen', parameters: PARAMETERS }),
  generateInputValues: () => ({ person: { alter: 35, niveau: 'Hoch' }, faktor: 1.5 }),
  EN_US: { id: 'en-US' }, ZH_CN: { id: 'zh-CN' }, DE_DE: { id: 'de-DE' },
}));
vi.mock('@/lib/api/error-envelope', () => ({
  extractErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('@/components/feedback/loading-skeleton', () => ({
  LoadingSkeleton: () => <div data-testid="loading" />,
}));

const SOURCE = 'Modul demo.\n\nRegel einstufen gegeben person als Fahrer, faktor als Dezimal, liefert Stufe:\n  gib zurück person.niveau.\n';

const fetchMock = vi.fn();
let executeResponse: unknown = {};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/api/policies/p1') && (!init?.method || init.method === 'GET')) {
      return Promise.resolve({ ok: true, json: async () => ({ name: 'Demo', content: SOURCE }) });
    }
    if (url.includes('/api/policies/p1/execute')) {
      return Promise.resolve({ ok: true, json: async () => executeResponse });
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
  executeResponse = {
    executionId: 'e1', success: true, durationMs: 1,
    output: { matchedRules: [], actions: [], approved: true, metadata: {} },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WAIT = { timeout: 5000 };
const jsonInput = () => document.querySelector('textarea[name="jsonInput"]') as HTMLTextAreaElement;
const field = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
const lastExecuteBody = () => {
  const call = [...fetchMock.mock.calls].reverse().find(([u]) => String(u).includes('/execute'));
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};

async function renderPage() {
  const { ExecutePolicyContent } = await import(
    '@/app/[locale]/(dashboard)/policies/[id]/execute/execute-policy-content'
  );
  render(<ExecutePolicyContent policyId="p1" locale="de" />);
  await waitFor(() => expect(JSON.parse(jsonInput().value)).toEqual({ person: { alter: 35, niveau: 'Hoch' }, faktor: 1.5 }), WAIT);
}

const showForm = () => fireEvent.click(screen.getByRole('button', { name: 'Form' }));
const showJson = () => fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
const execute = () => fireEvent.click(screen.getByText('policies.execute.executeButton').closest('button')!);

describe('ExecutePolicyContent — 表单与 JSON 是同一份输入（#635）', () => {
  it('表单里改的值执行后切回 JSON 视图仍在，提交的也是它', async () => {
    await renderPage();
    showForm();
    fireEvent.change(field('person-niveau'), { target: { value: 'Niedrig' } });
    fireEvent.change(field('person-alter'), { target: { value: '21' } });
    execute();
    await waitFor(() => expect(lastExecuteBody()).toBeDefined(), WAIT);
    expect(lastExecuteBody().input).toEqual({ person: { alter: 21, niveau: 'Niedrig' }, faktor: 1.5 });

    showJson();
    expect(JSON.parse(jsonInput().value)).toEqual({ person: { alter: 21, niveau: 'Niedrig' }, faktor: 1.5 });
  });

  it('JSON 里改的值切到表单后显示出来', async () => {
    await renderPage();
    fireEvent.change(jsonInput(), { target: { value: '{"person":{"alter":50,"niveau":"Niedrig"},"faktor":2}' } });
    showForm();
    expect(field('person-alter').value).toBe('50');
    expect(field('person-niveau').value).toBe('Niedrig');
    expect(field('faktor').value).toBe('2');
  });

  it('JSON 不是对象时表单模式提示无效 JSON，不显示（也不能覆盖）字段', async () => {
    await renderPage();
    fireEvent.change(jsonInput(), { target: { value: '{"person":' } });
    showForm();
    expect(screen.getByRole('alert')).toHaveTextContent('policies.execute.invalidJson');
    expect(document.getElementById('person-alter')).toBeNull();
    showJson();
    expect(jsonInput().value).toBe('{"person":');
  });
});

describe('ExecutePolicyContent — 数字输入（#635）', () => {
  it('不暴露虚假的 aria-valuemin / aria-valuemax，用数字键盘的文本框', async () => {
    await renderPage();
    showForm();
    for (const id of ['person-alter', 'faktor']) {
      const input = field(id) as HTMLInputElement;
      expect(input.type).toBe('text');
      expect(input).not.toHaveAttribute('aria-valuemin');
      expect(input).not.toHaveAttribute('aria-valuemax');
      expect(input).not.toHaveAttribute('min');
      expect(input).not.toHaveAttribute('max');
    }
    expect(field('person-alter')).toHaveAttribute('inputmode', 'numeric');
    expect(field('faktor')).toHaveAttribute('inputmode', 'decimal');
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('完整数字写成数字；输入中途的半成品原样保留，不被改成 0', async () => {
    await renderPage();
    showForm();
    fireEvent.change(field('person-alter'), { target: { value: '-' } });
    expect(field('person-alter').value).toBe('-');
    fireEvent.change(field('person-alter'), { target: { value: '-7' } });
    fireEvent.change(field('faktor'), { target: { value: '2.' } });
    expect(field('faktor').value).toBe('2.');
    fireEvent.change(field('faktor'), { target: { value: '2.25' } });
    showJson();
    expect(JSON.parse(jsonInput().value)).toEqual({ person: { alter: -7, niveau: 'Hoch' }, faktor: 2.25 });
  });
});

describe('ExecutePolicyContent — 枚举结果展示（#633）', () => {
  it('结果是枚举值对象时显示策略语言的成员名', async () => {
    executeResponse = {
      executionId: 'e2', success: true, durationMs: 1,
      output: {
        matchedRules: [], actions: [], approved: true, metadata: { decision: 'indeterminate' },
        result: { __type: '?', _enum: 'Level', value: 'High', variant: 'High', args: [] },
      },
      localizedResult: { __type: '?', _enum: 'Stufe', value: 'Hoch', variant: 'Hoch', args: [] },
    };
    await renderPage();
    execute();
    await waitFor(() => expect(screen.getByText('Hoch')).toBeInTheDocument(), WAIT);
    // 结果区只显示成员名，不显示枚举对象的 JSON
    expect(screen.getByText('Hoch').tagName).toBe('PRE');
  });
});
