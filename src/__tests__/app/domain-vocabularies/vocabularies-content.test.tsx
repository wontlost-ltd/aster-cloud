// 词汇列表页：日期 hydration（#611）、配额卡计数与「最近删除」分页（#616）、刷新后找回异步任务（#605）。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('lucide-react', async (orig) => ({ ...((await orig()) as Record<string, unknown>) }));
// 保存后会 router.refresh() 重新拉 RSC；测试环境没有 App Router 上下文，只替换 useRouter
const router = vi.hoisted(() => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
  usePathname: () => '/domain-vocabularies',
  useRouter: () => router,
}));

// t 必须是稳定引用：真实 next-intl 的 t 不随渲染变化，组件把它放进 effect 依赖。
const t = vi.hoisted(() => (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key);
vi.mock('next-intl', () => ({
  useTranslations: () => t,
  useLocale: () => 'en',
}));

import {
  VocabulariesContent,
  type SerializableTermLink,
} from '@/app/[locale]/(dashboard)/domain-vocabularies/vocabularies-content';

// 2026-10-24T13:16Z：UTC 下是 10 月 24 日，Pacific/Auckland（UTC+13）下已是 10 月 25 日。
const UPDATED_AT = '2026-10-24T13:16:00.000Z';

const term = (id: string, extra: Partial<SerializableTermLink> = {}): SerializableTermLink => ({
  id,
  termId: `t-${id}`,
  userId: 'user-1',
  domain: 'finance',
  locale: 'en',
  kind: 'struct',
  canonical: `Loan${id}`,
  localized: `Loan ${id}`,
  parentCanonical: null,
  aliases: [],
  description: null,
  source: 'user',
  createdAt: UPDATED_AT,
  updatedAt: UPDATED_AT,
  ...extra,
});

const baseProps = {
  initialTerms: [term('1')],
  initialTotal: 3,
  activeCount: 120,
  initialActiveJobId: null,
  initialDeletedTerms: [term('9', { deletedAt: UPDATED_AT })],
  initialDeletedCount: 1,
  initialPage: 1,
  initialPageSize: 50,
  initialFilters: { domain: 'finance', locale: '', kind: '' },
  initialQuery: '',
  quota: {
    maxTerms: 5000,
    bulkAsync: true,
    allowed: true,
    plan: 'pro',
    downgraded: false,
    trialEndsAt: null,
  },
};

const originalTz = process.env.TZ;

beforeEach(() => {
  vi.mocked(global.fetch).mockReset();
});

afterEach(() => {
  process.env.TZ = originalTz;
  document.body.innerHTML = '';
});

describe('VocabulariesContent — 更新时间 hydration（#611）', () => {
  it('服务端 UTC、浏览器 Pacific/Auckland 时 hydrate 不报 mismatch，按 UTC 日历日显示', async () => {
    process.env.TZ = 'UTC';
    const html = renderToString(<VocabulariesContent {...baseProps} />);
    expect(html).toContain('Oct 24, 2026');

    process.env.TZ = 'Pacific/Auckland';
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    const recoverable: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(container, <VocabulariesContent {...baseProps} />, {
        onRecoverableError: (err) => recoverable.push(err),
      });
    });
    const mismatchLogs = consoleError.mock.calls.filter((args) => /hydrat/i.test(String(args[0])));
    consoleError.mockRestore();

    expect(recoverable).toEqual([]);
    expect(mismatchLogs).toEqual([]);
    expect(container.textContent).toContain('Oct 24, 2026');
    expect(container.textContent).not.toContain('Oct 25, 2026');
  });
});

describe('VocabulariesContent — 计数（#616）', () => {
  it('配额卡用不受筛选影响的活跃总数，而不是筛选后的 total', () => {
    render(<VocabulariesContent {...baseProps} />);
    expect(screen.getByText('quota.used:{"used":120,"total":5000}')).toBeInTheDocument();
    expect(screen.queryByText('quota.used:{"used":3,"total":5000}')).toBeNull();
  });

  it('「最近删除」视图不显示按活跃总数计算的分页器', () => {
    const { container } = render(<VocabulariesContent {...baseProps} initialTotal={6} />);
    // 活跃视图：分页器按活跃总数显示「1-6 / 6」。
    expect(container.textContent).toContain('showing:{"start":1,"end":6,"total":6');
    fireEvent.click(screen.getByRole('button', { name: 'actions.recentlyDeleted' }));
    expect(screen.getByText('Loan9')).toBeInTheDocument();
    expect(container.textContent).not.toContain('showing:');
  });
});

describe('VocabulariesContent — 刷新后找回异步任务（#605）', () => {
  it('服务端带回的 queued 任务直接显示进度卡并开始轮询', async () => {
    vi.mocked(global.fetch).mockImplementation(async () =>
      new Response(
        JSON.stringify({
          job: {
            id: 'job-7',
            status: 'queued',
            rowCount: 3,
            processed: 0,
            rollup: {},
            errors: [],
            updatedAt: UPDATED_AT,
            completedAt: null,
          },
        }),
        { status: 200 },
      ),
    );
    await act(async () => {
      render(<VocabulariesContent {...baseProps} initialActiveJobId="job-7" />);
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/domain-vocabularies/bulk/jobs/job-7',
      expect.anything(),
    );
    expect(await screen.findByText('status.queued')).toBeInTheDocument();
  });
});

/* 第 4 轮生产复测（中，数据丢失）：编辑对话框不回填 aliases / description，直接保存会清空已存值。 */
describe('VocabulariesContent — 编辑对话框回填别名与描述', () => {
  it('★点 Edit 后别名与描述回填；不改直接保存，PATCH 带回原值', async () => {
    const row = term('1', { aliases: ['hochstufe', 'oben'], description: 'Hohe Stufe' });
    vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ link: row }), { status: 200 }));
    render(<VocabulariesContent {...baseProps} initialTerms={[row]} />);
    fireEvent.click(screen.getAllByText('actions.edit')[0]!);

    expect((document.getElementById('vd-aliases') as HTMLInputElement).value).toBe('hochstufe, oben');
    expect((document.getElementById('vd-description') as HTMLTextAreaElement).value).toBe('Hohe Stufe');

    const form = document.getElementById('vd-aliases')!.closest('form')!;
    await act(async () => { fireEvent.submit(form); });
    const patch = vi.mocked(global.fetch).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toMatchObject({ aliases: ['hochstufe', 'oben'], description: 'Hohe Stufe' });
  });

  it('★清空别名与描述后保存：PATCH 显式带 aliases: [] 与 description: null（而不是省略）', async () => {
    const row = term('1', { aliases: ['hochstufe'], description: 'Hohe Stufe' });
    vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ link: row }), { status: 200 }));
    render(<VocabulariesContent {...baseProps} initialTerms={[row]} />);
    fireEvent.click(screen.getAllByText('actions.edit')[0]!);
    fireEvent.change(document.getElementById('vd-aliases')!, { target: { value: '' } });
    fireEvent.change(document.getElementById('vd-description')!, { target: { value: '  ' } });
    const form = document.getElementById('vd-aliases')!.closest('form')!;
    await act(async () => { fireEvent.submit(form); });
    const patch = vi.mocked(global.fetch).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    const body = JSON.parse(String((patch![1] as RequestInit).body));
    expect(body.aliases).toEqual([]);
    expect(body.description).toBeNull();
  });
});
