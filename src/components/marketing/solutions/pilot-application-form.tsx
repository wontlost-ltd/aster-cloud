'use client';

/**
 * 「申请试点」表单。提交到 /api/pilot-applications；来源归因在提交时从 URL 与 referrer 读取，
 * 与落地页访问事件同一口径。`website` 是对真人隐藏的蜜罐字段（屏幕阅读器与 Tab 也跳过）。
 */
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, AlertTitle, Button, Input, Label, Select, Textarea } from '@/components/ui';
import { Link } from '@/i18n/navigation';
import { readAttribution } from '@/lib/product-events/definitions';
import { PILOT_ROLES, PILOT_USE_CASES, type PilotUseCase, type SolutionSlug } from '@/lib/solutions';

type Status = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'done' } | { kind: 'error'; message: string };

const FIELD_ERRORS = ['email', 'company', 'role', 'useCases', 'painPoint', 'consent'] as const;

export function PilotApplicationForm({
  page,
  locale,
  defaultUseCase,
}: {
  page: SolutionSlug;
  locale: string;
  defaultUseCase: PilotUseCase;
}) {
  const t = useTranslations('solutionsPage.form');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [useCases, setUseCases] = useState<PilotUseCase[]>([defaultUseCase]);
  const [painPoint, setPainPoint] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const toggleUseCase = (value: PilotUseCase) => {
    setUseCases((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!consent) {
      setStatus({ kind: 'error', message: t('errors.consent') });
      return;
    }
    if (useCases.length === 0) {
      setStatus({ kind: 'error', message: t('errors.useCases') });
      return;
    }
    setStatus({ kind: 'submitting' });
    // 提交时读取归因：同一次页面访问内 URL 与 referrer 不变，与落地页访问事件同口径。
    const attribution = readAttribution(window.location.href, document.referrer);
    try {
      const res = await fetch('/api/pilot-applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, company, role, useCases, painPoint, consent, page, locale, attribution, website }),
      });
      if (res.ok) {
        setStatus({ kind: 'done' });
        return;
      }
      if (res.status === 429) {
        setStatus({ kind: 'error', message: t('errors.rateLimited') });
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { field?: string };
      const field = FIELD_ERRORS.find((f) => f === body.field);
      setStatus({ kind: 'error', message: field ? t(`errors.${field}`) : t('errors.generic') });
    } catch {
      setStatus({ kind: 'error', message: t('errors.generic') });
    }
  };

  if (status.kind === 'done') {
    return (
      <Alert variant="success" role="status">
        <AlertTitle>{t('successTitle')}</AlertTitle>
        <AlertDescription>{t('successBody')}</AlertDescription>
      </Alert>
    );
  }

  const submitting = status.kind === 'submitting';
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pilot-email">{t('email')}</Label>
          <Input
            id="pilot-email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pilot-company">{t('company')}</Label>
          <Input
            id="pilot-company"
            autoComplete="organization"
            required
            maxLength={200}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pilot-role">{t('role')}</Label>
        <Select id="pilot-role" required value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="" disabled>{t('rolePlaceholder')}</option>
          {PILOT_ROLES.map((r) => (
            <option key={r} value={r}>{t(`roles.${r}`)}</option>
          ))}
        </Select>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-fg">{t('useCasesLegend')}</legend>
        {PILOT_USE_CASES.map((u) => (
          <label key={u} className="flex items-start gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--aster-primary,#7c3aed)]"
              checked={useCases.includes(u)}
              onChange={() => toggleUseCase(u)}
            />
            <span>{t(`useCases.${u}`)}</span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="pilot-pain">{t('painPoint')}</Label>
        <Textarea
          id="pilot-pain"
          rows={4}
          maxLength={2000}
          placeholder={t('painPointPlaceholder')}
          value={painPoint}
          onChange={(e) => setPainPoint(e.target.value)}
        />
      </div>

      {/* 蜜罐：对真人不可见、不可聚焦；脚本自动填表会填上它。 */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="pilot-website">{t('honeypot')}</label>
        <input
          id="pilot-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      <label className="flex items-start gap-2 text-sm text-fg-muted">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[var(--aster-primary,#7c3aed)]"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          required
        />
        <span>
          {t('consent')}{' '}
          <Link href="/privacy" className="text-primary underline-offset-2 hover:underline">
            {t('privacyLink')}
          </Link>
        </span>
      </label>

      {status.kind === 'error' && (
        <Alert variant="danger" role="alert">
          <AlertDescription>{status.message}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" variant="primary" size="lg" disabled={submitting}>
        {submitting ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}
