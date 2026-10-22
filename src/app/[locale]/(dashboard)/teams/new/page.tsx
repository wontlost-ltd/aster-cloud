'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Container, PageHeader, Input, Label } from '@/components/ui';
import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';
import { extractErrorMessage } from '@/lib/api/error-envelope';
import {
  generateSlug,
  randomSlugSuffix,
  validateSlug,
  validateTeamName,
} from '@/lib/validation';

export default function NewTeamPage() {
  const t = useTranslations('teams');
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  // 字段级校验错误：表单用 noValidate 关掉浏览器原生气泡（只有英文/系统语言），
  // 提交时按与服务端同一套规则（lib/validation）校验并显示本地化文案。
  const [nameError, setNameError] = useState('');
  const [slugError, setSlugError] = useState('');
  // 名称里没有可用 ASCII 时 slug 的兜底后缀：整个表单生命周期内固定，避免每次键入都变。
  const [slugSuffix] = useState(randomSlugSuffix);
  const [formData, setFormData] = useState({
    name: '',
    slug: '',
  });

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    setNameError('');
    setSlugError('');
    setFormData({
      name,
      // 名称清空时 slug 也清空，而不是留下一个与名称无关的兜底值。
      slug: name.trim() ? generateSlug(name, slugSuffix) : '',
    });
  };

  const handleSlugChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    setSlugError('');
    setFormData((prev) => ({
      ...prev,
      slug,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nameOk = validateTeamName(formData.name).valid;
    const slugOk = validateSlug(formData.slug).valid;
    setNameError(nameOk ? '' : t('createTeam.nameInvalid'));
    setSlugError(slugOk ? '' : t('createTeam.slugInvalid'));
    if (!nameOk || !slugOk) return;

    setIsLoading(true);
    setError('');

    try {
      const res = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.upgrade) {
          // SaaS: redirect to billing to upgrade. on-prem: no billing page,
          // surface the upgrade-required message as an inline error so the
          // operator knows to contact admin (team caps are license-driven).
          if (CLIENT_CAPABILITIES.billing) {
            router.push('/billing');
            return;
          }
          setError(t('upgradeRequired.contactAdmin'));
          return;
        }
        throw new Error(extractErrorMessage(data) || 'Failed to create team');
      }

      router.push(`/teams/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('failedToCreate'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* 顶层页：去 Breadcrumbs（sidebar 高亮 + PageHeader h1 已显页名）。 */}
      <PageHeader
        title={t('createTeam.title')}
        subtitle={t('createTeam.subtitle')}
        className="mb-6"
      />

      <div className="rounded-lg border border-border bg-bg shadow-sm">
        <form onSubmit={handleSubmit} noValidate className="px-6 py-4 space-y-6">
          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Design-system Input replaces the previous hand-rolled
              <input> so border / focus ring / typography match the
              Storybook contract. */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">{t('createTeam.nameLabel')}</Label>
            <Input
              type="text"
              id="name"
              name="name"
              required
              minLength={2}
              maxLength={50}
              value={formData.name}
              onChange={handleNameChange}
              placeholder={t('createTeam.namePlaceholder')}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? 'name-error' : undefined}
            />
            {nameError && (
              <p id="name-error" role="alert" className="text-xs text-red-700 dark:text-red-300">
                {nameError}
              </p>
            )}
            <p className="text-xs text-fg-muted">{t('createTeam.nameHint')}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="slug">{t('createTeam.slugLabel')}</Label>
            <div className="flex">
              <span className="inline-flex items-center rounded-l-md border border-r-0 border-border bg-bg-subtle px-3 text-sm text-fg-muted">
                /teams/
              </span>
              <Input
                type="text"
                id="slug"
                name="slug"
                required
                minLength={2}
                maxLength={50}
                value={formData.slug}
                onChange={handleSlugChange}
                className="rounded-l-none"
                placeholder={t('createTeam.slugPlaceholder')}
                aria-invalid={slugError ? true : undefined}
                aria-describedby={slugError ? 'slug-error' : undefined}
              />
            </div>
            {slugError && (
              <p id="slug-error" role="alert" className="text-xs text-red-700 dark:text-red-300">
                {slugError}
              </p>
            )}
            <p className="text-xs text-fg-muted">{t('createTeam.slugHint')}</p>
          </div>

          <div className="flex justify-end space-x-3 pt-4 border-t border-border">
            <Link
              href="/teams"
              className="inline-flex items-center rounded-md border border-border-strong bg-bg px-4 py-2 text-sm font-medium text-fg shadow-sm hover:bg-bg-subtle"
            >
              {t('cancel')}
            </Link>
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  {t('creating')}
                </>
              ) : (
                t('createTeam.submitButton')
              )}
            </button>
          </div>
        </form>
      </div>
    </Container>
  );
}
