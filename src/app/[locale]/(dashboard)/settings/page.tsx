/**
 * User settings — server shell + client islands.
 *
 * Server-rendered:
 *   - Title / subtitle
 *   - Setting cards layout + copy
 *   - Profile values pulled directly from session.user (no client-side
 *     useSession() round-trip, no first-paint "Not set" flicker)
 *   - Initial value of the locale-detection toggle, read from the
 *     server-side cookie so the switch never flips on-then-off after
 *     hydration
 *
 * Client islands (settings-client.tsx):
 *   - LocaleDetectionToggle  → cookie write + router.refresh()
 *   - SignOutButton          → next-auth signOut()
 *   - DeleteAccountFlow      → destructive confirm + DELETE call
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { defaultLocale } from '@/i18n/config';
import { getSession } from '@/lib/auth';
import {
  buttonVariants,
  Card,
  CardBody,
  Container,
  PageHeader,
  Stack,
  cn,
} from '@/components/ui';
import {
  LocaleDetectionToggle,
  AssistantToggle,
  SignOutButton,
  DeleteAccountFlow,
} from './settings-client';
import { TrustedDevicesPanel } from '@/components/settings/trusted-devices-panel';

const LOCALE_DETECTION_COOKIE = 'aster-locale-detection';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export default async function SettingsPage({ params }: PageProps) {
  const { locale } = await params;
  const session = await getSession();
  if (!session?.user) {
    redirect(`/${locale}/login`);
  }

  const t = await getTranslations('settings');
  // 助手文案是顶层命名空间（面板/设置共用同一套），故单独绑一个 translator。
  const tAssistant = await getTranslations('assistant');

  // Seed the toggle's initial state on the server so it doesn't flip
  // after hydration. Cookie absent ⇒ feature off (matches prior client
  // behavior).
  const cookieStore = await cookies();
  const localeDetection =
    cookieStore.get(LOCALE_DETECTION_COOKIE)?.value === 'true';

  const localePrefix = locale === defaultLocale ? '' : `/${locale}`;
  const logoutCallbackUrl = `${localePrefix}/`;

  const profileName = session.user.name || t('profile.notSet');
  const profileEmail = session.user.email || t('profile.notSet');
  // session.user.plan is a custom field stitched on by the NextAuth
  // callback; fall back to "Free" when the trial/seed user hasn't been
  // assigned a plan yet.
  const profilePlan = (session.user as { plan?: string }).plan || 'Free';

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader title={t('title')} subtitle={t('subtitle')} className="mb-6" />
      <Stack gap={6}>
        {/* API Keys */}
        <SettingCard
          title={t('apiKeys.title')}
          description={t('apiKeys.subtitle')}
          action={
            <Link
              href="/settings/api-keys"
              className={buttonVariants({ variant: 'secondary', size: 'md' })}
            >
              {t('apiKeys.manageKeys')}
            </Link>
          }
        />

        {/* AI Keys (BYOK). Was previously only reachable via cmdk — surfacing
            it as a Settings card so admins/users on a fresh tenant can find
            the OpenAI/Anthropic/Vertex binding flow without a keyboard shortcut. */}
        <SettingCard
          title={t('aiKeys.title')}
          description={t('aiKeys.subtitle')}
          action={
            <Link
              href="/settings/ai-keys"
              className={buttonVariants({ variant: 'secondary', size: 'md' })}
            >
              {t('aiKeys.manageKeys')}
            </Link>
          }
        />

        {/* GDPR data — Article 15 (access) + Article 17 (erasure). */}
        <SettingCard
          title={t('dataCard.title')}
          description={t('dataCard.subtitle')}
          action={
            <Link
              href="/settings/data"
              className={buttonVariants({ variant: 'secondary', size: 'md' })}
            >
              {t('dataCard.open')}
            </Link>
          }
        />

        {/* Language preferences (client toggle island) */}
        <Card>
          <CardBody className="pt-6">
            <Stack gap={4}>
              <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
                {t('language.title')}
              </h2>
              <Stack direction="row" justify="between" align="center" gap={4}>
                <Stack gap={1}>
                  <p className="text-sm font-medium text-fg">{t('language.autoDetect')}</p>
                  <p className="text-sm text-fg-muted">{t('language.autoDetectDesc')}</p>
                </Stack>
                <LocaleDetectionToggle
                  initialChecked={localeDetection}
                  ariaLabel={t('language.autoDetect')}
                  enabledHint={t('language.enabled')}
                  disabledHint={t('language.disabled')}
                />
              </Stack>
            </Stack>
          </CardBody>
        </Card>

        {/* 站内助手开关（client island）。
            ★这是助手停用后唯一的重新激活入口——面板自身的关闭按钮只是收起。 */}
        <Card>
          <CardBody className="pt-6">
            <Stack gap={4}>
              <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
                {tAssistant('settingsLabel')}
              </h2>
              <Stack direction="row" justify="between" align="center" gap={4}>
                <Stack gap={1}>
                  <p className="text-sm font-medium text-fg">{tAssistant('title')}</p>
                  <p className="text-sm text-fg-muted">{tAssistant('settingsHint')}</p>
                </Stack>
                <AssistantToggle
                  ariaLabel={tAssistant('settingsLabel')}
                  enabledHint={tAssistant('settingsOn')}
                  disabledHint={tAssistant('settingsOff')}
                />
              </Stack>
            </Stack>
          </CardBody>
        </Card>

        {/* Profile fields — rendered fully on the server now. */}
        <Card>
          <CardBody className="pt-6">
            <Stack gap={4}>
              <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
                {t('profile.title')}
              </h2>
              <Stack gap={3}>
                <ProfileField label={t('profile.name')} value={profileName} />
                <ProfileField label={t('profile.email')} value={profileEmail} />
                <ProfileField label={t('profile.plan')} value={profilePlan} capitalize />
              </Stack>
            </Stack>
          </CardBody>
        </Card>

        {/* Account actions (sign out — client island) */}
        <SettingCard
          title={t('account.title')}
          subtitle={t('account.signOut')}
          description={t('account.signOutDesc')}
          action={
            <SignOutButton
              signOutLabel={t('account.signOut')}
              signingOutLabel={t('account.signingOut')}
              callbackUrl={logoutCallbackUrl}
            />
          }
        />

        {/* 已信任设备（issue #400）——用户勾过「记住该设备」的那些。 */}
        <TrustedDevicesPanel
          labels={{
            title: t('trustedDevices.title'),
            description: t('trustedDevices.description'),
            empty: t('trustedDevices.empty'),
            unknownDevice: t('trustedDevices.unknownDevice'),
            lastUsed: t('trustedDevices.lastUsed'),
            never: t('trustedDevices.never'),
            expires: t('trustedDevices.expires'),
            remove: t('trustedDevices.remove'),
            removing: t('trustedDevices.removing'),
            loadFailed: t('trustedDevices.loadFailed'),
            removeFailed: t('trustedDevices.removeFailed'),
          }}
        />

        {/* Danger zone — destructive flow lives in the client island. */}
        <Card className="border-rose-200">
          <CardBody className="pt-6">
            <Stack gap={4}>
              <h2 className="font-display text-xl font-semibold tracking-tight text-danger">
                {t('dangerZone.title')}
              </h2>
              <Stack direction="row" justify="between" align="center" gap={4}>
                <Stack gap={1}>
                  <p className="text-sm font-medium text-fg">{t('dangerZone.deleteAccount')}</p>
                  <p className="text-sm text-fg-muted">{t('dangerZone.deleteAccountDesc')}</p>
                </Stack>
                <DeleteAccountFlow
                  triggerLabel={t('dangerZone.deleteAccount')}
                  callbackUrl={logoutCallbackUrl}
                  labels={{
                    confirmTitle: t('dangerZone.confirmTitle'),
                    confirmMessage: t('dangerZone.confirmMessage'),
                    confirmItem1: t('dangerZone.confirmItem1'),
                    confirmItem2: t('dangerZone.confirmItem2'),
                    confirmItem3: t('dangerZone.confirmItem3'),
                    confirmDelete: t('dangerZone.confirmDelete'),
                    cancel: t('dangerZone.cancel'),
                    deleting: t('dangerZone.deleting'),
                  }}
                />
              </Stack>
            </Stack>
          </CardBody>
        </Card>
      </Stack>
    </Container>
  );
}

/* ------------------------------------------------------------------ */
/* SettingCard — server-rendered card with right-aligned action       */
/* ------------------------------------------------------------------ */

interface SettingCardProps {
  title: string;
  subtitle?: string;
  description: string;
  action: React.ReactNode;
}

function SettingCard({ title, subtitle, description, action }: SettingCardProps) {
  return (
    <Card>
      <CardBody className="pt-6">
        <Stack direction="row" justify="between" align="center" gap={4} wrap>
          <Stack gap={1} className="min-w-0 flex-1">
            <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
              {title}
            </h2>
            {subtitle && (
              <p className="text-sm font-medium text-fg">{subtitle}</p>
            )}
            <p className="text-sm text-fg-muted">{description}</p>
          </Stack>
          <div className="shrink-0">{action}</div>
        </Stack>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* ProfileField — label above value                                    */
/* ------------------------------------------------------------------ */

function ProfileField({
  label, value, capitalize,
}: { label: string; value: string; capitalize?: boolean }) {
  return (
    <Stack gap={1}>
      <p className="text-sm font-medium text-fg-muted">{label}</p>
      <p className={cn('text-sm text-fg', capitalize && 'capitalize')}>{value}</p>
    </Stack>
  );
}
