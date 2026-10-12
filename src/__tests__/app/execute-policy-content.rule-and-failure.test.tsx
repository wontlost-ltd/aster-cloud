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
  pi: [],
  only: [{ name: 'z', type: 'Int', typeKind: 'primitive' }],
};
const extractSchema = vi.fn((_src: string, opts?: { functionName?: string }) => {
  const fn = opts?.functionName ?? 'power';
  if (fn === 'broken') return { success: false, error: "Function 'broken' not found" };
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
  '',
  'Rule pi produce Int:',
  '  Return 3.',
  '',
  'Rule broken produce Int:',
  '  Return 0.',
].join('\n');

// @entry 不在首位：默认 Rule 应为 calculate，首屏示例不能按第一个函数 power 生成。
const ENTRY_SECOND_SOURCE = [
  'Module demo.calc.',
  '',
  'Rule power given base as Int, exponent as Int, produce Int:',
  '  Return base.',
  '',
  '@entry',
  'Rule calculate given request as Text, produce Int:',
  '  Return 0.',
].join('\n');

let currentSource = SOURCE;

const fetchMock = vi.fn();
let executeResponse: unknown = {};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  extractSchema.mockClear();
  currentSource = SOURCE;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/api/policies/p1') && (!init || !init.method || init.method === 'GET')) {
      return Promise.resolve({ ok: true, json: async () => ({ name: 'Calc', content: currentSource }) });
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

// 取最近一次执行请求的 body。
const lastExecuteBody = () => {
  const call = [...fetchMock.mock.calls].reverse().find(([u]) => String(u).includes('/execute'));
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};

describe('ExecutePolicyContent — 切换到无参数或提取失败的 Rule 时清掉旧参数', () => {
  // 先在 power 上切到表单模式，再换 Rule：旧实现保留 power 的 schema/formValues，
  // 表单模式会把 {base, exponent} 提交给新 Rule。
  async function switchFromPowerFormTo(rule: string) {
    executeResponse = { executionId: 'e3', success: true, durationMs: 1, output: { matchedRules: [], actions: [], approved: true, metadata: {} } };
    const select = await renderPage();
    fireEvent.change(select, { target: { value: 'power' } });
    await waitFor(() => expect(JSON.parse(jsonInput().value)).toEqual({ base: 'sample', exponent: 'sample' }), WAIT);
    fireEvent.click(screen.getByText('Form'));
    fireEvent.change(select, { target: { value: rule } });
    await waitFor(() => expect(extractSchema.mock.calls.some(([, o]) => o?.functionName === rule)).toBe(true), WAIT);
    fireEvent.click(screen.getByText('policies.execute.executeButton').closest('button')!);
    await waitFor(() => expect(lastExecuteBody()).toBeDefined(), WAIT);
    return lastExecuteBody();
  }

  it('新 Rule 没有参数：提交空输入，不带旧 Rule 的参数', async () => {
    const body = await switchFromPowerFormTo('pi');
    expect(body).toEqual({ input: {}, functionName: 'pi' });
    expect(screen.queryByText('base')).not.toBeInTheDocument();
  });

  it('新 Rule 的 schema 提取失败：提交空输入，不带旧 Rule 的参数', async () => {
    const body = await switchFromPowerFormTo('broken');
    expect(body).toEqual({ input: {}, functionName: 'broken' });
    expect(screen.queryByText('base')).not.toBeInTheDocument();
  });
});

describe('ExecutePolicyContent — @entry 不在首位时首屏只按 @entry 提取', () => {
  it('从加载起每次提取都用 @entry Rule，从不回落到第一个函数', async () => {
    currentSource = ENTRY_SECOND_SOURCE;
    // 有唯一 @entry 时页面不渲染 Rule 选择框，故直接等 JSON 输入区就绪。
    const { ExecutePolicyContent } = await import(
      '@/app/[locale]/(dashboard)/policies/[id]/execute/execute-policy-content'
    );
    render(<ExecutePolicyContent policyId="p1" locale="en" />);
    await waitFor(() => expect(JSON.parse(jsonInput().value)).toEqual({ request: 'sample' }), WAIT);
    // 再给 effect 一个回合，确认没有额外的回落提取。
    await new Promise((r) => setTimeout(r, 50));
    const used = extractSchema.mock.calls.map(([, o]) => o?.functionName ?? null);
    expect(used).toEqual(['calculate']);
  });
});

describe('ExecutePolicyContent — 加载后立即切换 Rule 不被覆盖', () => {
  /**
   * 确定性复现竞态：加载那次 commit 之后、passive effect 刷新之前切换 Rule。
   * fireEvent 自带 act 会先刷完 effect，测不到这个窗口；这里在 MutationObserver 回调
   * （commit 后的微任务，早于 scheduler 刷 passive effect）里同步改值并派发原生 change。
   * 若 ruleSymbols effect 无条件重置为默认 Rule，用户的选择会被覆盖，本用例变红。
   */
  it('★加载 commit 后、effect 刷新前切换的 Rule 保持选中，示例按该 Rule 生成', async () => {
    const { ExecutePolicyContent } = await import(
      '@/app/[locale]/(dashboard)/policies/[id]/execute/execute-policy-content'
    );
    let fired = false;
    const mo = new MutationObserver(() => {
      if (fired) return;
      const select = document.querySelector('select') as HTMLSelectElement | null;
      if (!select || select.options.length < 3) return;
      fired = true;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'calculate');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    render(<ExecutePolicyContent policyId="p1" locale="en" />);
    try {
      await waitFor(() => expect(fired).toBe(true), WAIT);
    } finally {
      mo.disconnect();
    }
    await waitFor(() => {
      const select = document.querySelector('select') as HTMLSelectElement;
      expect(select.value).toBe('calculate');
      expect(JSON.parse(jsonInput().value)).toEqual({ request: 'sample' });
    }, WAIT);
  });
});

describe('ExecutePolicyContent — ENTRY_AMBIGUOUS 候选按钮只选中 Rule，不用旧输入执行', () => {
  const ambiguous = {
    success: false,
    error: 'ambiguous entry',
    diagnostics: [{ code: 'ENTRY_AMBIGUOUS', message: '未指定入口函数，候选函数不唯一', candidates: ['power', 'calculate'] }],
  };
  const executeCalls = () =>
    fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/execute') && init?.method === 'POST');

  it('★多 Rule、无 @entry 且未选 Rule 时执行按钮禁用（不白跑一次）', async () => {
    await renderPage();
    const button = screen.getByTestId('execute-policy-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(executeCalls()).toHaveLength(0);
  });

  it('★点击候选：不再发执行请求，选中该 Rule，示例换成该 Rule 的参数，提示与旧结果收起', async () => {
    // 兜底场景：前端已选 Rule，服务端仍判入口不唯一（前后端判断不一致）
    executeResponse = ambiguous;
    const select = await renderPage();
    fireEvent.change(select, { target: { value: 'power' } });
    await waitFor(() => expect(JSON.parse(jsonInput().value)).toEqual({ base: 'sample', exponent: 'sample' }), WAIT);
    fireEvent.click(screen.getByTestId('execute-policy-button'));
    const candidate = await screen.findByRole('button', { name: 'calculate' }, WAIT);
    expect(executeCalls()).toHaveLength(1);
    // 提示用本地化文案，而非服务端写死的中文 message
    expect(screen.getByText('policies.execute.entryAmbiguousBody')).toBeTruthy();
    // 原始 JSON（<pre>）里仍有服务端 message，故按元素整段文本精确匹配
    expect(screen.queryByText('未指定入口函数，候选函数不唯一')).toBeNull();
    expect(document.body.textContent).toContain('ambiguous entry');

    fireEvent.click(candidate);

    await waitFor(() => {
      expect((document.querySelector('select') as HTMLSelectElement).value).toBe('calculate');
      expect(JSON.parse(jsonInput().value)).toEqual({ request: 'sample' });
    }, WAIT);
    expect(executeCalls()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'calculate' })).toBeNull();
    expect(document.body.textContent).not.toContain('ambiguous entry');
  });
});

describe('ExecutePolicyContent — 加载请求忽略过期响应', () => {
  it('★policyId 切换后，旧请求被中止，其响应晚到也不会覆盖新策略的内容', async () => {
    let p1Signal: AbortSignal | undefined;
    const P2_SOURCE = ['Module demo.p2.', '', 'Rule only given z as Int, produce Int:', '  Return z.'].join('\n');
    let releaseP1: () => void = () => {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const isGet = !init || !init.method || init.method === 'GET';
      if (url.endsWith('/api/policies/p1') && isGet) {
        p1Signal = init?.signal ?? undefined;
        return new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          releaseP1 = () => resolve({ ok: true, json: async () => ({ name: 'Old', content: SOURCE }) });
        });
      }
      if (url.endsWith('/api/policies/p2') && isGet) {
        return Promise.resolve({ ok: true, json: async () => ({ name: 'New', content: P2_SOURCE }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    const { ExecutePolicyContent } = await import(
      '@/app/[locale]/(dashboard)/policies/[id]/execute/execute-policy-content'
    );
    const view = render(<ExecutePolicyContent policyId="p1" locale="en" />);
    view.rerender(<ExecutePolicyContent policyId="p2" locale="en" />);
    await waitFor(() => expect(JSON.parse(jsonInput().value)).toEqual({ z: 'sample' }), WAIT);
    expect(p1Signal?.aborted).toBe(true);

    releaseP1();
    await new Promise((r) => setTimeout(r, 50));

    expect(JSON.parse(jsonInput().value)).toEqual({ z: 'sample' });
    expect(screen.queryByText('Old')).toBeNull();
  });

  it('★旧请求在新策略加载后才失败：不显示加载失败，也不清空新策略的输入', async () => {
    const P2_SOURCE = ['Module demo.p2.', '', 'Rule only given z as Int, produce Int:', '  Return z.'].join('\n');
    let failP1: () => void = () => {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const isGet = !init || !init.method || init.method === 'GET';
      if (url.endsWith('/api/policies/p1') && isGet) {
        // 无视 signal，在新策略加载之后才失败
        return new Promise((_resolve, reject) => {
          failP1 = () => reject(new Error('HTTP 500 fetching policy p1'));
        });
      }
      if (url.endsWith('/api/policies/p2') && isGet) {
        return Promise.resolve({ ok: true, json: async () => ({ name: 'New', content: P2_SOURCE }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    const { ExecutePolicyContent } = await import(
      '@/app/[locale]/(dashboard)/policies/[id]/execute/execute-policy-content'
    );
    const view = render(<ExecutePolicyContent policyId="p1" locale="en" />);
    view.rerender(<ExecutePolicyContent policyId="p2" locale="en" />);
    await waitFor(() => expect(JSON.parse(jsonInput().value)).toEqual({ z: 'sample' }), WAIT);

    failP1();
    await new Promise((r) => setTimeout(r, 50));

    expect(JSON.parse(jsonInput().value)).toEqual({ z: 'sample' });
    expect(document.body.textContent).not.toContain('HTTP 500 fetching policy p1');
  });

  it('★旧请求未能被中止（响应已在途）时，晚到的数据也被丢弃', async () => {
    const P2_SOURCE = ['Module demo.p2.', '', 'Rule only given z as Int, produce Int:', '  Return z.'].join('\n');
    let releaseP1: () => void = () => {};
    // 模拟 abort 来不及生效：旧请求无视 signal，照常 resolve
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const isGet = !init || !init.method || init.method === 'GET';
      if (url.endsWith('/api/policies/p1') && isGet) {
        return new Promise((resolve) => {
          releaseP1 = () => resolve({ ok: true, json: async () => ({ name: 'Old', content: SOURCE }) });
        });
      }
      if (url.endsWith('/api/policies/p2') && isGet) {
        return Promise.resolve({ ok: true, json: async () => ({ name: 'New', content: P2_SOURCE }) });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    const { ExecutePolicyContent } = await import(
      '@/app/[locale]/(dashboard)/policies/[id]/execute/execute-policy-content'
    );
    const view = render(<ExecutePolicyContent policyId="p1" locale="en" />);
    view.rerender(<ExecutePolicyContent policyId="p2" locale="en" />);
    await waitFor(() => expect(JSON.parse(jsonInput().value)).toEqual({ z: 'sample' }), WAIT);

    releaseP1();
    await new Promise((r) => setTimeout(r, 50));

    expect(JSON.parse(jsonInput().value)).toEqual({ z: 'sample' });
    expect(screen.queryByText('Old')).toBeNull();
  });
});
