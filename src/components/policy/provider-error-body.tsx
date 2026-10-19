'use client';

import type { ProviderErrorView } from '@/lib/provider-error';

interface Props {
  view: ProviderErrorView;
  /** next-intl `ai` 命名空间的翻译函数。 */
  t: (key: string, values?: Record<string, string>) => string;
  /** 设置 → AI 密钥页（含 locale 前缀）。 */
  href: string;
}

/**
 * provider 错误的展示体：本地化主文案 + provider 原话（次要行）+ 去修正 key/模型的入口。
 * 选哪条文案由纯函数 providerErrorView 决定，这里只负责渲染。
 */
export function ProviderErrorBody({ view, t, href }: Props) {
  return (
    <>
      <span>{t(view.messageKey, view.values)}</span>
      {view.providerMessage && (
        <span className="mt-1 block opacity-80" data-testid="provider-error-detail">
          {view.providerMessage}
        </span>
      )}
      {view.showAiKeysLink && (
        <a href={href} className="mt-1 inline-block underline font-medium hover:no-underline">
          {t('goAiKeys')}
        </a>
      )}
    </>
  );
}
