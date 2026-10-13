/**
 * 条件漏斗口径说明的文案接线：sampleNote / coverageNote / truncatedNote 带 ICU 占位符，
 * 由面板自行替换数值。若用 t() 取（未传 values）会触发 FORMATTING_ERROR，客户端兜底把整串
 * key（conditionFunnel.sampleNote）显示给用户，常驻的口径说明随之丢失。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { PolicyAnalyticsSection } from '@/components/policy/policy-analytics-section';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FUNNEL = {
  sampleSize: 5,
  withSkeleton: 3,
  coverage: 0.6,
  sampleNote: 'analytics.funnel.sampleNote',
  steps: [{ nodeId: 'n1', label: 'req.action', evaluated: 3, matched: 1 }],
  neverMatchedInSample: [],
  scanned: 5,
  total: 9,
  truncated: true,
};

describe('PolicyAnalyticsSection', () => {
  it('口径说明按真实数值渲染，不出现 conditionFunnel.* 兜底 key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => FUNNEL })));
    render(
      <NextIntlClientProvider
        locale="en"
        messages={DEMO_SUPPLEMENT.en as never}
        getMessageFallback={({ namespace, key }) => (namespace ? `${namespace}.${key}` : key)}
        onError={() => {}}
      >
        <PolicyAnalyticsSection policyId="p1" currentVersion={1} />
      </NextIntlClientProvider>,
    );

    const note = await screen.findByText(/Based on 3 executions recorded by the platform/);
    expect(note.textContent).toContain('Only 3 of 5 executions carried a decision skeleton.');
    expect(note.textContent).toContain('Showing the most recent 5 of 9 executions');
    expect(document.body.textContent).not.toContain('conditionFunnel.');
  });
});
