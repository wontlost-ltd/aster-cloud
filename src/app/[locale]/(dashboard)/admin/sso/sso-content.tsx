// SsoConfigContent — 客户端 SSO 配置展示。
//
// 三种 provider 状态各有独立面板：
//   - none: 引导：要启用 SSO，请设 SSO_PROVIDER=saml|oidc
//   - saml: 显示 SP entityId / ACS URL（IdP 端要配的字段，含 copy 按钮）
//          + IdP 端字段（metadata URL / cert fingerprint / SLO URL）
//   - oidc: 显示 issuer / callbackURL / client ID / scopes
//          + secret 配置状态（仅 boolean，不暴露值）
//
// incomplete 状态：显著横幅列出 missingFields。

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Container, PageHeader } from '@/components/ui';
import type {
  SsoIntrospection,
  SsoSamlConfig,
  SsoOidcConfig,
} from '@/lib/sso';

interface Props {
  introspection: SsoIntrospection;
}

export function SsoConfigContent({ introspection }: Props) {
  const t = useTranslations('admin.sso');
  const { config, health, missingFields } = introspection;

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        className="mb-6"
      />

      <div className="space-y-6">
        {health === 'incomplete' && (
          <IncompleteBanner missingFields={missingFields} />
        )}

        {config.provider === 'none' && <NoneStatePanel />}
        {config.provider === 'saml' && <SamlPanel config={config} />}
        {config.provider === 'oidc' && <OidcPanel config={config} />}
      </div>
    </Container>
  );
}

// ─── Panels ──────────────────────────────────────────────────────────

function IncompleteBanner({
  missingFields,
}: {
  missingFields: ReadonlyArray<string>;
}) {
  const t = useTranslations('admin.sso');
  return (
    <section
      role="alert"
      className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-900/20"
    >
      <h2 className="text-base font-semibold text-amber-900 dark:text-amber-200">
        {t('incomplete.title')}
      </h2>
      <p className="mt-1 text-sm text-amber-900/90 dark:text-amber-200/90">
        {t('incomplete.body')}
      </p>
      <ul
        className="mt-2 list-disc pl-5 text-sm text-amber-900 dark:text-amber-200"
        role="list"
      >
        {missingFields.map((f) => (
          <li key={f}>
            <code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs dark:bg-amber-900/40">
              {f}
            </code>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NoneStatePanel() {
  const t = useTranslations('admin.sso');
  return (
    <section
      aria-labelledby="sso-none-heading"
      className="rounded-lg border border-border bg-bg p-5"
    >
      <h2 id="sso-none-heading" className="text-base font-semibold text-fg">
        {t('none.title')}
      </h2>
      <p className="mt-2 text-sm text-fg-muted">{t('none.body')}</p>
      <div className="mt-3 rounded bg-bg-subtle p-3 font-mono text-xs">
        <div>SSO_PROVIDER=saml</div>
        <div># 或</div>
        <div>SSO_PROVIDER=oidc</div>
      </div>
      <p className="mt-3 text-xs text-fg-muted">{t('none.docsHint')}</p>
    </section>
  );
}

function SamlPanel({ config }: { config: SsoSamlConfig }) {
  const t = useTranslations('admin.sso');
  return (
    <>
      <section
        aria-labelledby="sso-saml-sp-heading"
        className="rounded-lg border border-border bg-bg p-5"
      >
        <h2
          id="sso-saml-sp-heading"
          className="text-base font-semibold text-fg"
        >
          {t('saml.spHeading')}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">{t('saml.spHint')}</p>
        <dl className="mt-4 grid grid-cols-1 gap-y-3 text-sm sm:grid-cols-3">
          <DetailRow label={t('saml.entityId')}>
            <CopyableValue value={config.entityId} />
          </DetailRow>
          <DetailRow label={t('saml.acsUrl')}>
            <CopyableValue value={config.acsUrl} />
          </DetailRow>
        </dl>
      </section>

      <section
        aria-labelledby="sso-saml-idp-heading"
        className="rounded-lg border border-border bg-bg p-5"
      >
        <h2
          id="sso-saml-idp-heading"
          className="text-base font-semibold text-fg"
        >
          {t('saml.idpHeading')}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">{t('saml.idpHint')}</p>
        <dl className="mt-4 grid grid-cols-1 gap-y-3 text-sm sm:grid-cols-3">
          <DetailRow label={t('saml.metadataUrl')}>
            {config.idpMetadataUrl ? (
              <CopyableValue value={config.idpMetadataUrl} />
            ) : (
              <span className="text-fg-muted">{t('saml.notConfigured')}</span>
            )}
          </DetailRow>
          <DetailRow label={t('saml.certFingerprint')}>
            {config.idpCertFingerprint ? (
              <code className="break-all font-mono text-xs">
                {config.idpCertFingerprint}
              </code>
            ) : (
              <span className="text-fg-muted">{t('saml.notConfigured')}</span>
            )}
          </DetailRow>
          <DetailRow label={t('saml.sloUrl')}>
            {config.idpSloUrl ? (
              <CopyableValue value={config.idpSloUrl} />
            ) : (
              <span className="text-fg-muted">{t('saml.notConfigured')}</span>
            )}
          </DetailRow>
        </dl>
      </section>
    </>
  );
}

function OidcPanel({ config }: { config: SsoOidcConfig }) {
  const t = useTranslations('admin.sso');
  return (
    <>
      <section
        aria-labelledby="sso-oidc-app-heading"
        className="rounded-lg border border-border bg-bg p-5"
      >
        <h2
          id="sso-oidc-app-heading"
          className="text-base font-semibold text-fg"
        >
          {t('oidc.appHeading')}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">{t('oidc.appHint')}</p>
        <dl className="mt-4 grid grid-cols-1 gap-y-3 text-sm sm:grid-cols-3">
          <DetailRow label={t('oidc.callbackUrl')}>
            <CopyableValue value={config.callbackUrl} />
          </DetailRow>
        </dl>
      </section>

      <section
        aria-labelledby="sso-oidc-idp-heading"
        className="rounded-lg border border-border bg-bg p-5"
      >
        <h2
          id="sso-oidc-idp-heading"
          className="text-base font-semibold text-fg"
        >
          {t('oidc.idpHeading')}
        </h2>
        <p className="mt-1 text-sm text-fg-muted">{t('oidc.idpHint')}</p>
        <dl className="mt-4 grid grid-cols-1 gap-y-3 text-sm sm:grid-cols-3">
          <DetailRow label={t('oidc.issuer')}>
            {config.issuer ? (
              <CopyableValue value={config.issuer} />
            ) : (
              <span className="text-fg-muted">{t('oidc.notConfigured')}</span>
            )}
          </DetailRow>
          <DetailRow label={t('oidc.clientId')}>
            {config.clientId ? (
              <code className="font-mono text-xs">{config.clientId}</code>
            ) : (
              <span className="text-fg-muted">{t('oidc.notConfigured')}</span>
            )}
          </DetailRow>
          <DetailRow label={t('oidc.clientSecret')}>
            {config.hasClientSecret ? (
              <span className="inline-flex items-center gap-1 text-sm">
                <span
                  aria-hidden
                  className="size-2 rounded-full bg-emerald-500"
                />
                {t('oidc.secretConfigured')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-sm text-red-700 dark:text-red-300">
                <span
                  aria-hidden
                  className="size-2 rounded-full bg-red-500"
                />
                {t('oidc.secretMissing')}
              </span>
            )}
          </DetailRow>
          <DetailRow label={t('oidc.scopes')}>
            <ul className="flex flex-wrap gap-1" role="list">
              {config.scopes.map((s) => (
                <li key={s}>
                  <code className="rounded bg-bg-subtle px-1.5 py-0.5 text-xs">
                    {s}
                  </code>
                </li>
              ))}
            </ul>
          </DetailRow>
        </dl>
      </section>
    </>
  );
}

// ─── Shared subcomponents ────────────────────────────────────────────

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      {/* min-w-0 + 可断行：ACS / 回调 URL、证书指纹都是无空格长串，窄屏下不得撑出视口 */}
      <dd className="min-w-0 break-words sm:col-span-2">{children}</dd>
    </>
  );
}

function CopyableValue({ value }: { value: string }) {
  const t = useTranslations('admin.sso');
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 浏览器拒绝 clipboard API — 静默忽略；用户可手动复制
    }
  };

  return (
    <span className="inline-flex max-w-full items-center gap-2">
      <code className="min-w-0 break-all font-mono text-xs">{value}</code>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={t('copyValue', { label: value })}
        className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-fg-muted hover:bg-bg-subtle hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        {copied ? t('copied') : t('copy')}
      </button>
    </span>
  );
}
