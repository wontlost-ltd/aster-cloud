/**
 * Admin tool: 站内助手设置（总开关 + 附加指令）。
 *
 * 路由保护：server-side admin 判定不通过 → notFound（不暴露页面存在），
 * 与 risk-tier / ai-circuit-breaker 同口径。
 */
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { isAdminFromSession } from '@/lib/admin-auth';
import {
  PLATFORM_SETTING_KEYS,
  ASSISTANT_INSTRUCTIONS_MAX_LEN,
  getSetting,
} from '@/lib/platform-settings';
import { AssistantAdminContent } from './assistant-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('admin.assistant', 'title');

type Props = {
  params: Promise<{ locale: string }>;
};

export const dynamic = 'force-dynamic';

export default async function AssistantAdminPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const admin = await isAdminFromSession();
  if (!admin) {
    notFound();
  }

  const t = await getTranslations('admin.assistant');

  // 服务端读初值，避免开关渲染后再翻转（同 LocaleDetectionToggle 的取舍）。
  const enabled = await getSetting(PLATFORM_SETTING_KEYS.ASSISTANT_ENABLED);
  const instructions = await getSetting(PLATFORM_SETTING_KEYS.ASSISTANT_EXTRA_INSTRUCTIONS);

  return (
    <AssistantAdminContent
      initialEnabled={enabled !== false}
      initialInstructions={typeof instructions === 'string' ? instructions : ''}
      enabledKey={PLATFORM_SETTING_KEYS.ASSISTANT_ENABLED}
      instructionsKey={PLATFORM_SETTING_KEYS.ASSISTANT_EXTRA_INSTRUCTIONS}
      maxLen={ASSISTANT_INSTRUCTIONS_MAX_LEN}
      labels={{
        title: t('title'),
        subtitle: t('subtitle'),
        enabledLabel: t('enabledLabel'),
        enabledHint: t('enabledHint'),
        disabledHint: t('disabledHint'),
        instructionsLabel: t('instructionsLabel'),
        instructionsHint: t('instructionsHint'),
        instructionsPlaceholder: t('instructionsPlaceholder'),
        constraintsNotice: t('constraintsNotice'),
        save: t('save'),
        saving: t('saving'),
        saved: t('saved'),
        saveFailed: t('saveFailed'),
        tooLong: t('tooLong'),
        cacheNotice: t('cacheNotice'),
      }}
    />
  );
}
