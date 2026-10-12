// 执行页两处缺陷的回归测试：
//   1. 「生成示例」/参数表必须跟随所选 Rule（曾恒按第一个 Rule 生成）。
//   2. 引擎执行失败（metadata.engineError）不能把「决策」显示成「拒绝」。
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

// 按 functionName 返回各 Rule 自己的参数表；未传 functionName 时回落第一个 Rule（与真实编译器一致）。
const PARAMS: Record<string, { name: string; type: string; typeKind: string }[]> = {
  power: [{ name: 'base', type: 'Int', typeKind: 'primitive' }, { name: 'exponent', type: 'Int', typeKind: 'primitive' }],
  calculate: [{ name: 'request', type: 'Text', typeKind: 'primitive' }],
};
const extractSchema = vi.fn((_src: string, opts?: { functionName?: string }) => {
  const fn = opts?.functionName ?? 'power';
  return { success: true, functionName: fn, parameters: PARAMS[fn] };
});
vi.mock('@aster-cloud/aster-lang-ts/browser', () => ({
  extractSchema: (src: string, opts?: { functionName?: string }) => extractSchema(src, opts),
  generateFieldValue: vi.fn(() => 'sample'),
  generateInputValues: vi.fn((params: { name: string }[]) =>
    Object.fromEntries(params.map((p) => [p.name, 'sample']))),
  EN_US: { id: 'en-US' }, ZH_CN: { id: 'zh-CN' }, DE_DE: { id: 'de-DE' },
}));
vi.mock('@/lib/api/error-envelope', () => ({
  extractErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('@/components/feedback/loading-skeleton', () => ({
  LoadingSkeleton: () => <div data-testid="loading" />,
}));

const SOURCE = [
  'Module demo.calc.',
  '',
  'Rule power given base as Int, exponent as Int, produce Int:',
  '  Return base.',
  '',
  'Rule calculate given request as Text, produce Int:',
  '  Return 0.',
].join('\n');

const fetchMock = vi.fn();
let executeResponse: unknown = {};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  extractSchema.mockClear();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/api/policies/p1') && (!init || !init.method || init.method === 'GET')) {
      return Promise.resolve({ ok: true, json: async () => ({ name: 'Calc', content: SOURCE }) });
    }
    if (url.includes('/api/policies/p1/execute')) {
      return Promise.resolve({ ok: true, json: async () => executeResponse });
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  const { ExecutePolicyContent } = await import(
    '@/app/[locale]/(dashboard)/policies/[id]/execute/execute-policy-content'
  );
  render(<ExecutePolicyContent policyId="p1" locale="en" />);
  return waitFor(() => {
    const select = document.querySelector('main select, select') as HTMLSelectElement | null;
    if (!select || select.options.length < 3) throw new Error('rule selector not ready');
    return select;
  }, { timeout: 5000 });
}

// 首次 import 页面模块含冷编译，默认 1s 的 waitFor 在 CI 上会偶发超时。
const WAIT = { timeout: 5000 };

const jsonInput = () => document.querySelector('textarea[name="jsonInput"]') as HTMLTextAreaElement;

describe('ExecutePolicyContent — 示例跟随所选 Rule', () => {
  it('切换到 calculate 后按 calculate 提取参数并生成示例', async () => {
    const select = await renderPage();
    fireEvent.change(select, { target: { value: 'calculate' } });

    await waitFor(() => {
      expect(extractSchema.mock.calls.some(([, o]) => o?.functionName === 'calculate')).toBe(true);
      expect(JSON.parse(jsonInput().value)).toEqual({ request: 'sample' });
    }, WAIT);
  });

  it('再切回 power 时示例同步回 power 的参数', async () => {
    const select = await renderPage();
    fireEvent.change(select, { target: { value: 'calculate' } });
    await waitFor(() => expect(JSON.parse(jsonInput().value)).toEqual({ request: 'sample' }), WAIT);
    fireEvent.change(select, { target: { value: 'power' } });
    await waitFor(() => expect(JSON.parse(jsonInput().value)).toEqual({ base: 'sample', exponent: 'sample' }), WAIT);
  });
});

describe('ExecutePolicyContent — 引擎执行失败不显示为拒绝', () => {
  it('engineError 时决策显示「执行失败」而不是「拒绝」', async () => {
    executeResponse = {
      executionId: 'e1', success: false, durationMs: 5,
      error: 'CNL 动态执行失败: Lambda func_power expects at least 2 arguments',
      output: {
        matchedRules: [], actions: [], approved: false, allowed: false,
        deniedReasons: ['CNL 动态执行失败: Lambda func_power expects at least 2 arguments'],
        metadata: { engineError: true },
      },
    };
    const select = await renderPage();
    fireEvent.change(select, { target: { value: 'calculate' } });
    fireEvent.click(screen.getByText('policies.execute.executeButton').closest('button')!);

    await waitFor(() => expect(screen.getByText('policies.execute.executionFailed')).toBeInTheDocument(), WAIT);
    expect(screen.queryByText('policies.execute.rejected')).not.toBeInTheDocument();
  });

  it('真实拒绝仍显示「拒绝」', async () => {
    executeResponse = {
      executionId: 'e2', success: false, durationMs: 5, error: 'dti_exceeds_limit',
      output: { matchedRules: [], actions: [], approved: false, deniedReasons: ['dti_exceeds_limit'], metadata: {} },
    };
    const select = await renderPage();
    fireEvent.change(select, { target: { value: 'calculate' } });
    fireEvent.click(screen.getByText('policies.execute.executeButton').closest('button')!);

    await waitFor(() => expect(screen.getByText('policies.execute.rejected')).toBeInTheDocument(), WAIT);
    expect(screen.queryByText('policies.execute.executionFailed')).not.toBeInTheDocument();
  });
});
