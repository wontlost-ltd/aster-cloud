import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { IntlClientProvider } from '@/i18n/intl-client-provider';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { WhatIfBatchPanel } from '@/components/policy/whatif-batch-panel';

/**
 * What-If 面板（ADR 0034 S4）。
 *
 * ★本文件的重点不是「渲染没报错」，而是**三条不能被绕过的呈现约束**：
 *   1. 拒答态**零业务数字**——连成功数都不给，否则用户会自己算成功率
 *   2. 进行中**不显示成功数**——否则用户在批次跑完前就推断出结论
 *   3. 「无法估算」**不得渲染成 0**——那会被读成「换版本没有金额影响」
 *
 * 这三条正是上一版 Phase 4 的死因在呈现层的投影。
 */

/**
 * ★用**真实**的 demo-supplement 文案，不自造 mock——
 * 否则断言的是自己编的字符串，测不到「文案里那句解释是否还在」。
 */
function render(ui: ReactElement) {
  return rtlRender(
    <IntlClientProvider locale="en" messages={DEMO_SUPPLEMENT.en as never}>
      {ui}
    </IntlClientProvider>,
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const props = {
  policyId: 'p1',
  baseVersionId: 'v1',
  targetVersionId: 'v2',
  entitled: true,
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('What-If 面板：呈现约束（ADR 0034 §1.1）', () => {
  describe('拒答态', () => {
    const rejected = {
      batchId: 'b1',
      status: 'FAILED' as const,
      windowLabel: 'Last month',
      windowFrom: '2026-07-08T00:00:00Z',
      windowTo: '2026-08-08T00:00:00Z',
      plannedCount: 200,
      failureKinds: ['INPUT_INCOMPATIBLE', 'TIMEOUT'],
      rejected: true,
    };

    it('★拒答态不得出现任何业务数字', async () => {
      fetchMock.mockResolvedValue(jsonResponse(rejected, 202));
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });

      await waitFor(() => expect(screen.getByText(/No results for/i)).toBeTruthy());

      const body = document.body.textContent ?? '';
      // 失败原因分布里的数字是允许的（170/30），但不得出现「成功了几条」
      expect(body).not.toMatch(/decisions changed/i);
      expect(body).not.toMatch(/newly approved/i);
      expect(body).not.toMatch(/newly rejected/i);
      expect(body).not.toMatch(/estimated value/i);
    });

    it('★拒答要解释「为什么不给数字」，而不只是说失败', async () => {
      fetchMock.mockResolvedValue(jsonResponse(rejected, 202));
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });

      await waitFor(() =>
        // 用户要理解：不是「系统坏了」，是「剩下的样本不代表总体」
        expect(screen.getByText(/would not represent the full population/i)).toBeTruthy(),
      );
    });

    it('★服务端繁忙与数据不兼容必须给出不同解释', async () => {
      // ★fixture 必须同时含两类失败——本用例验的正是「两者文案不同」
      fetchMock.mockResolvedValue(
        jsonResponse({ ...rejected, failureKinds: ['INPUT_INCOMPATIBLE', 'THROTTLED'] }, 202),
      );
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });

      await waitFor(() => {
        // THROTTLED 必须明说「不是你的数据的问题」，否则用户去改自己没错的数据
        // ★用 body.textContent：文案分散在多个列表项元素里
        const body = document.body.textContent ?? '';
        expect(body).toMatch(/not a problem with your data/i);
        expect(body).toMatch(/incompatible with the target version/i);
      });
    });
  });

  describe('空窗口', () => {
    // ★服务端用 FAILED + 空 failureKinds 数组表达「窗口内没有任何执行」。
    //   它**不是**拒答：拒答是「有样本但部分跑不了」，空窗口是「压根没样本」。
    //   混为一谈会让用户去排查并不存在的数据故障。
    const empty = {
      batchId: 'b0',
      status: 'FAILED' as const,
      windowLabel: 'Last month',
      windowFrom: '2026-07-08T00:00:00Z',
      windowTo: '2026-08-08T00:00:00Z',
      failureKinds: [],
      rejected: true,
    };

    it('★空窗口必须说「没有执行记录」，不得说「有部分执行无法重跑」', async () => {
      fetchMock.mockResolvedValue(jsonResponse(empty, 202));
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });

      await waitFor(() =>
        expect(screen.getByText(/No executions were recorded/i)).toBeTruthy(),
      );
      // 这句是给「有样本但跑不了」用的，空窗口时说它就是不实陈述
      expect(document.body.textContent).not.toMatch(
        /would not represent the full population/i,
      );
    });

    it('空窗口同样不给任何业务数字', async () => {
      fetchMock.mockResolvedValue(jsonResponse(empty, 202));
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });

      await waitFor(() =>
        expect(screen.getByText(/No executions were recorded/i)).toBeTruthy(),
      );
      const body = document.body.textContent ?? '';
      expect(body).not.toMatch(/decisions changed/i);
      expect(body).not.toMatch(/estimated value/i);
    });
  });

  describe('进行中', () => {
    it('★只显示已处理数，不显示成功数', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            batchId: 'b2',
            status: 'RUNNING',
            windowLabel: 'Last quarter',
            windowFrom: '2026-05-08T00:00:00Z',
            windowTo: '2026-08-08T00:00:00Z',
            plannedCount: 100,
            processedCount: 60,
          },
          202,
        ),
      );
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });

      await waitFor(() => expect(screen.getByText(/60 \/ 100/)).toBeTruthy());

      const body = document.body.textContent ?? '';
      expect(body).not.toMatch(/succeeded/i);
      expect(body).not.toMatch(/success rate/i);
      // 明确告诉用户「跑完才有结果」，避免中途推断
      expect(body).toMatch(/only after every execution/i);
    });
  });

  describe('完成态', () => {
    const base = {
      batchId: 'b3',
      status: 'COMPLETED' as const,
      windowLabel: 'Last month',
      windowFrom: '2026-07-08T00:00:00Z',
      windowTo: '2026-08-08T00:00:00Z',
      plannedCount: 42,
    };

    it('★数字必须与窗口口径同屏', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            ...base,
            result: {
              changed: 5,
              newlyApproved: 3,
              newlyRejected: 2,
              totalSampled: 42,
              estimatedValueDelta: 1200,
            },
          },
          202,
        ),
      );
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });

      await waitFor(() => {
        // 「基于近一个月全部 42 条」——用户要知道自己看的是哪个总体
        const body = document.body.textContent ?? '';
        expect(body).toMatch(/all 42/i);
        expect(body).toMatch(/Last month/);
      });
    });

    it('★无金额基线显示「不可用」而非 0', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            ...base,
            result: {
              changed: 5,
              newlyApproved: 3,
              newlyRejected: 2,
              totalSampled: 42,
              estimatedValueDelta: null,
            },
          },
          202,
        ),
      );
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });

      await waitFor(() =>
        expect(screen.getByText(/cannot be estimated/i)).toBeTruthy(),
      );
      // 渲染成 0 会被读成「换版本没有金额影响」——一个没有依据的结论
      expect(document.body.textContent).not.toMatch(/Estimated value change:?\s*0\b/);
    });
  });

  describe('权益与并发（§7.2 / §7.5）', () => {
    it('★free 租户：入口可见但禁用 + 升级引导，且不给样例数字', () => {
      render(<WhatIfBatchPanel {...props} entitled={false} />);

      // 入口可见——完全隐藏会失去转化机会
      expect(screen.getByText(/What-if impact estimate/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /run analysis/i })).toHaveProperty('disabled', true);
      expect(screen.getByText(/requires a/i)).toBeTruthy();

      // ★禁用态不得给试用额度或样例数字，否则 §1.1 在营销路径上被绕过
      const body = document.body.textContent ?? '';
      expect(body).not.toMatch(/\d+\s*(decisions|changed|approved|rejected)/i);
    });

    it('403 提示升级而非「稍后再试」', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ error: 'whatif_not_entitled' }, 403));
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });

      await waitFor(() => expect(screen.getByText(/requires a Pro plan/i)).toBeTruthy());
      expect(document.body.textContent).not.toMatch(/already running/i);
    });

    it('★409 提示等待并给出当前批次——与 403 是不同的话', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ error: 'whatif_batch_in_progress', currentBatchId: 'abcdef1234' }, 409),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            batchId: 'abcdef1234',
            status: 'RUNNING',
            windowLabel: 'Last month',
            windowFrom: 'x',
            windowTo: 'y',
            plannedCount: 10,
            processedCount: 4,
          }),
        );
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });

      await waitFor(() => expect(screen.getByText(/already running/i)).toBeTruthy());
      // 不该说「去升级」——用户有权益，只是要等
      expect(document.body.textContent).not.toMatch(/requires a Pro plan/i);
    });
  });

  describe('窗口选择（§7.1）', () => {
    it('★自定义日期上限为今天——不能选未来', async () => {
      render(<WhatIfBatchPanel {...props} />);
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'CUSTOM' } });

      const inputs = screen.getAllByDisplayValue('') as HTMLInputElement[];
      const dateInputs = inputs.filter((i) => i.type === 'date');
      expect(dateInputs.length).toBe(2);

      const today = new Date();
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      for (const el of dateInputs) {
        expect(el.max).toBe(iso);
      }
    });

    it('四个预设档位齐备', () => {
      render(<WhatIfBatchPanel {...props} />);
      const options = screen.getAllByRole('option').map((o) => o.textContent);
      expect(options).toEqual(
        expect.arrayContaining([
          'Last month',
          'Last quarter',
          'Last 6 months',
          'Last year',
          'Custom range',
        ]),
      );
    });
  });
  // ── 窗口名称必须本地化（生产实测 bug）─────────────────────────────
  //
  // ★服务端下发的 windowLabel 是**硬编码中文**（"最近一个月"），
  //   不分语言。生产英文界面实测显示成中文。
  //   既有用例的 fixture 全用 'Last month' 这类英文字符串——那不是
  //   服务端真实返回的形态，所以这个 bug 一直测不出来。
  //   这里用**真实的服务端 payload**（中文 label + windowKind）。
  describe('窗口名称本地化', () => {
    const zhLabelPayload = {
      batchId: 'b-i18n',
      status: 'FAILED' as const,
      windowKind: 'LAST_MONTH',
      windowLabel: '最近一个月', // ← 服务端真实下发值
      windowFrom: '2026-07-16T00:00:00Z',
      windowTo: '2026-08-16T00:00:00Z',
      failureKinds: [],
      rejected: true,
    };

    it('★英文界面不得出现服务端下发的中文窗口名', async () => {
      fetchMock.mockResolvedValue(jsonResponse(zhLabelPayload, 202));
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });
      expect(
        document.body.textContent,
        '英文界面直接展示了服务端的中文 label',
      ).not.toContain('最近一个月');
    });

    it('★应显示本地化后的窗口名（与下拉框同一套文案）', async () => {
      fetchMock.mockResolvedValue(jsonResponse(zhLabelPayload, 202));
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });
      expect(document.body.textContent?.toLowerCase()).toContain('last month');
    });

    it('老版本 API 不下发 windowKind 时回退到 label（不至于空白）', async () => {
      const legacy = { ...zhLabelPayload, windowKind: undefined };
      fetchMock.mockResolvedValue(jsonResponse(legacy, 202));
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });
      // 回退是有意的：宁可显示中文，也不显示空白。
      expect(document.body.textContent).toContain('最近一个月');
    });
  });

  // ── 「含今天」开关（用户实测痛点）───────────────────────────────
  //
  // ★背景：默认右边界是当天 00:00，今天刚跑的执行要等到明天才进窗口。
  //   生产实测：改完策略立刻跑 What-If，永远是 "nothing to compare"。
  //   故提供显式开关；默认关闭，保住"同一档位重算得同一区间"的性质。
  describe('含今天开关', () => {
    it('★默认不勾选，且请求里 includeToday 为 false', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ batchId: 'b', status: 'PENDING',
        windowKind: 'LAST_MONTH', windowLabel: '最近一个月',
        windowFrom: '2026-07-16T00:00:00Z', windowTo: '2026-08-16T00:00:00Z',
        plannedCount: 1 }, 202));
      render(<WhatIfBatchPanel {...props} />);

      const cb = screen.getByRole('checkbox') as HTMLInputElement;
      expect(cb.checked, '默认必须关闭——默认语义不可改变').toBe(false);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.includeToday).toBe(false);
    });

    it('★勾选后请求里 includeToday 为 true', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ batchId: 'b', status: 'PENDING',
        windowKind: 'LAST_MONTH', windowLabel: '最近一个月',
        windowFrom: '2026-07-16T00:00:00Z', windowTo: '2026-08-16T12:00:00Z',
        plannedCount: 1 }, 202));
      render(<WhatIfBatchPanel {...props} />);

      fireEvent.click(screen.getByRole('checkbox'));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.includeToday, '勾选后未下发 → 后端仍按当天 00:00 截断').toBe(true);
    });

    it('CUSTOM 档位隐藏该开关（边界已由用户日期决定，无歧义）', async () => {
      render(<WhatIfBatchPanel {...props} />);
      expect(screen.queryByRole('checkbox')).not.toBeNull();
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'CUSTOM' } });
      expect(screen.queryByRole('checkbox')).toBeNull();
    });
  });

  // ── i18n key 必须都有定义（生产实测漏了一个）────────────────────────
  //
  // ★线上曾直接显示原始 key `whatIf.valueImpact:`——`t('valueImpact')` 被调用，
  //   但四个语种里都没定义该 key，next-intl 于是回显 key 本身。
  //
  // ★不用「渲染后断言页面不含 whatIf.」来测：实测把 key 删掉后该断言**仍然全绿**
  //   （测试里的 IntlProvider 回退行为与生产不同），那是个假绿。
  //   改为直接扫源码里所有 t('...') 调用，逐个核对四个语种的语言包——
  //   这才与真实失败模式对齐。
  it('★面板用到的 i18n key 必须在四个语种里都有定义', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'src/components/policy/whatif-batch-panel.tsx'),
      'utf8',
    );
    const keys = [...src.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)].map((m) => m[1]);
    expect(keys.length, '没扫到任何 t() 调用，正则可能失效了').toBeGreaterThan(5);

    const supplement = DEMO_SUPPLEMENT as unknown as Record<
      string,
      { whatIf?: Record<string, unknown> }
    >;
    for (const locale of ['en', 'zh', 'de', 'hi']) {
      const pack = supplement[locale]?.whatIf ?? {};
      const missing = keys.filter((k) => !(k in pack));
      expect(missing, `${locale} 缺少 i18n key（会在界面上回显原始 key）`).toEqual([]);
    }
  });

});
