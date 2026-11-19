/*
 * 复核面板的显示排版说明（ADR 0058 §7.7 第 7 条，计划 T8 / 裁决 R15）。
 * 面板只渲染 canonical 片段；活跃版本有 layout 时只在顶部加说明与指向版本页的链接，
 * 缺省 / 假时 DOM 与引入 layout 之前一致（快照在改动前固化）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({ useTranslations: (ns: string) => (key: string) => `${ns}.${key}` }));

import { PolicyReviewPanel } from '@/components/policy/policy-review-panel';

const HASH = 'a'.repeat(64);

function reviewBody() {
  return {
    items: [{ text: '10000', nodeId: '$.a', span: { start: 37, end: 42 }, reason: 'r', contentHash: HASH }],
    counts: { verified: 1, reviewRequired: 1, rejected: 0 },
    canReview: true, subjectKind: 'domain_expert', proofs: [], queueStatus: 'ok',
  };
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => reviewBody() }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPanel(props: Record<string, unknown> = {}) {
  stubFetch();
  const view = render(<PolicyReviewPanel policyId="p1" {...props} />);
  await waitFor(() => expect(screen.getByText('policyReview.title')).toBeDefined());
  return view;
}

describe('PolicyReviewPanel：无显示排版时 DOM 不变', () => {
  it('hasDisplayLayout 缺省：与改动前快照一致', async () => {
    const { container } = await renderPanel();
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('hasDisplayLayout = false：与改动前快照一致', async () => {
    const { container } = await renderPanel({ hasDisplayLayout: false });
    expect(container.innerHTML).toMatchSnapshot();
  });
});
