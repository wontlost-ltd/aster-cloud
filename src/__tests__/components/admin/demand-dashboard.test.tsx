import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: nav.refresh }) }));
import { DemandDashboard } from '@/app/[locale]/(dashboard)/admin/demand/demand-dashboard';
import type { DemandReport } from '@/lib/product-events/report';
import type { PilotApplication } from '@/lib/prisma';

const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.values(values).join(',')})` : key;

const report: DemandReport = {
  since: new Date('2026-08-09T00:00:00Z'),
  weekly: [
    { week: '2026-10-26', name: 'signup_completed', count: 4 },
    { week: '2026-10-26', name: 'guard_api_called', count: 120 },
    { week: '2026-10-19', name: 'landing_viewed', count: 9 },
  ],
  templates: [{ templateId: 'auto-insurance-quote', count: 3 }],
  funnel: { signups: 6, verifiedSignups: 4, firstSaved: 3, firstExecuted: 1, evidenceExported: 0 },
  landing: [{ page: 'insurance-rating', views: 8, submissions: 2 }],
  sources: [{ source: 'linkedin', views: 5 }],
  guardByTenant: [{ tenant: 'abc123', count: 120 }],
};

const application: PilotApplication = {
  id: 'a1', createdAt: new Date('2026-10-30T09:15:00Z'), email: 'jane@insurer.example', emailDomain: 'insurer.example',
  freeMailDomain: false, company: 'Example Mutual', role: 'actuarial_pricing', useCases: ['insurance_rating', 'other'],
  painPoint: null, consentAt: new Date('2026-10-30T09:15:00Z'), landingPage: 'insurance-rating', locale: 'en',
  utmSource: 'linkedin', utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null, referrerHost: null,
};

describe('DemandDashboard', () => {
  it('漏斗：分母为已验证注册，各步人数与占比', () => {
    render(<DemandDashboard report={report} applications={[]} t={t} exportHref="/x.csv" />);
    expect(screen.getByText('funnel.ofSignups(75%)')).toBeTruthy();
    expect(screen.getByText('funnel.ofSignups(25%)')).toBeTruthy();
    expect(screen.getByText('funnel.ofSignups(0%)')).toBeTruthy();
  });

  it('周计数表按周成行、事件成列，缺失补 0；Guard 调用列在内', () => {
    render(<DemandDashboard report={report} applications={[]} t={t} exportHref="/x.csv" />);
    const section = screen.getByRole('region', { name: 'weekly.heading' });
    const headers = within(section).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers[0]).toBe('weekly.week');
    expect(headers).toContain('guard_api_called');
    const rows = within(section).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0]).getAllByRole('cell').map((c) => c.textContent);
    expect(first[0]).toBe('2026-10-26');
    expect(first[headers.indexOf('signup_completed')]).toBe('4');
    expect(first[headers.indexOf('guard_api_called')]).toBe('120');
    expect(first[headers.indexOf('landing_viewed')]).toBe('0');
  });

  it('落地页转化率、申请列表与导出链接', () => {
    render(<DemandDashboard report={report} applications={[application]} t={t} exportHref="/api/admin/pilot-applications/export" />);
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getByText('/solutions/insurance-rating')).toBeTruthy();
    expect(screen.getByText('jane@insurer.example')).toBeTruthy();
    expect(screen.getByText('applications.companyDomain')).toBeTruthy();
    expect(screen.getByText('insurance_rating, other')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'applications.export' }).getAttribute('href')).toBe('/api/admin/pilot-applications/export');
  });

  it('无数据时显示空态', () => {
    render(
      <DemandDashboard
        report={{ ...report, weekly: [], templates: [], landing: [], sources: [], guardByTenant: [] }}
        applications={[]}
        t={t}
        exportHref="/x.csv"
      />,
    );
    expect(screen.getAllByText('empty').length).toBe(6);
  });

  it('落地页标注为方向性指标；页首说明保留期', () => {
    render(<DemandDashboard report={report} applications={[]} t={t} exportHref="/x.csv" />);
    expect(screen.getByText('landing.note')).toBeTruthy();
    expect(screen.getByText(/retentionNote/)).toBeTruthy();
  });

  it('删除申请：确认后调用 DELETE 并刷新列表', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DemandDashboard report={report} applications={[application]} t={t} exportHref="/x.csv" />);
    fireEvent.click(screen.getByRole('button', { name: 'applications.delete' }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/pilot-applications/a1', { method: 'DELETE' });
    vi.unstubAllGlobals();
  });
});
