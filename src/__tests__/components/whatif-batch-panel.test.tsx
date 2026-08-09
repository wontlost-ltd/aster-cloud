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
      failureReasons: { INPUT_INCOMPATIBLE: 170, TIMEOUT: 30 },
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
        jsonResponse({ ...rejected, failureReasons: { INPUT_INCOMPATIBLE: 170, THROTTLED: 30 } }, 202),
      );
      render(<WhatIfBatchPanel {...props} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /run analysis/i }));
      });

      await waitFor(() => {
        // THROTTLED 必须明说「不是你的数据的问题」，否则用户去改自己没错的数据
        // ★用 body.textContent：列表项里的文本被 <strong>{count}</strong> 拆成多元素
        const body = document.body.textContent ?? '';
        expect(body).toMatch(/not a problem with your data/i);
        expect(body).toMatch(/incompatible with the target version/i);
      });
    });
  });

  describe('空窗口', () => {
    // ★服务端用 FAILED + 空 failureReasons 表达「窗口内没有任何执行」。
    //   它**不是**拒答：拒答是「有样本但部分跑不了」，空窗口是「压根没样本」。
    //   混为一谈会让用户去排查并不存在的数据故障。
    const empty = {
      batchId: 'b0',
      status: 'FAILED' as const,
      windowLabel: 'Last month',
      windowFrom: '2026-07-08T00:00:00Z',
      windowTo: '2026-08-08T00:00:00Z',
      failureReasons: {},
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
});
