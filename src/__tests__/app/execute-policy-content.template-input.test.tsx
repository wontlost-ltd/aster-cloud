// 执行页预填（2026-10-30 生产复测 G）：由内置模板创建、源码未改的策略，预填模板自带的 defaultInputs；
// 源码改过的策略仍用按参数类型生成的示例。用真实浏览器编译器提取参数（不 mock aster-lang-ts）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { POLICY_EXAMPLES } from '@/data/policy-examples';

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
vi.mock('@/components/feedback/loading-skeleton', () => ({
  LoadingSkeleton: () => <div data-testid="loading" />,
}));

const auto = POLICY_EXAMPLES.find((e) => e.id === 'auto-insurance-quote')!;
let content = '';
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith('/api/policies/p1')) {
      return Promise.resolve({ ok: true, json: async () => ({ name: 'Auto', content }) });
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const jsonInput = () => document.querySelector('textarea[name="jsonInput"]') as HTMLTextAreaElement | null;

async function prefilled(): Promise<Record<string, unknown>> {
  const { ExecutePolicyContent } = await import(
    '@/app/[locale]/(dashboard)/policies/[id]/execute/execute-policy-content'
  );
  render(<ExecutePolicyContent policyId="p1" locale="en" />);
  await waitFor(() => expect(jsonInput()?.value ?? '').not.toBe(''), { timeout: 10000 });
  return JSON.parse(jsonInput()!.value);
}

describe('执行页预填模板 defaultInputs', () => {
  it('★Auto Insurance Quote（en）：预填模板输入，而不是空字符串示例', async () => {
    content = auto.sources['en-US'];
    expect(await prefilled()).toEqual(auto.defaultInputs['en-US']);
  });

  it('★Kfz-Versicherungsangebot（de）：预填德语模板输入', async () => {
    content = auto.sources['de-DE'];
    expect(await prefilled()).toEqual(auto.defaultInputs['de-DE']);
  });

  it('源码改过：退回按类型生成的示例', async () => {
    content = auto.sources['en-US'].replace('Module insurance.auto.', 'Module my.auto.');
    const input = await prefilled();
    expect(input).not.toEqual(auto.defaultInputs['en-US']);
    expect(Object.keys(input).sort()).toEqual(['driver', 'vehicle']);
  });
});
