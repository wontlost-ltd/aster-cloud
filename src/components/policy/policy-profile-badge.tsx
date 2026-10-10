'use client';

// 策略档案徽标（ADR 0046 §6）：以编译响应中的 profile 为准，不在客户端解析源码；
// 编译失败或未声明档案时不渲染，详情页其余内容不受影响。
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui';
import { localizedTitle, profileTitle } from '@/services/evidence/control-registry';

interface PolicyProfileBadgeProps {
  source: string;
  /** 源码的 CNL locale（如 zh-CN），与执行时一致。 */
  sourceLocale: string;
  /** 界面 locale，决定档案标题语言。 */
  locale: string;
  label: string;
}

async function fetchProfile(source: string, sourceLocale: string): Promise<string | null> {
  try {
    const r = await fetch('/api/policies/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, locale: sourceLocale }),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { profile?: unknown };
    return typeof body.profile === 'string' && body.profile !== '' ? body.profile : null;
  } catch {
    return null;
  }
}

export function PolicyProfileBadge({ source, sourceLocale, locale, label }: PolicyProfileBadgeProps) {
  const [profile, setProfile] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchProfile(source, sourceLocale).then((id) => {
      if (active) setProfile(id);
    });
    return () => {
      active = false;
    };
  }, [source, sourceLocale]);

  if (!profile) return null;
  return (
    <span className="inline-flex items-center gap-2 text-sm" data-testid="policy-profile">
      <span className="text-fg-muted">{label}</span>
      <Badge variant="primary">{localizedTitle(profileTitle(profile), locale)}</Badge>
    </span>
  );
}
