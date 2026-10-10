// 策略档案徽标（ADR 0046 §6）：档案 id 取自保存时落库的 PolicyVersion.profile，不再编译；
// 未声明档案或旧版本（NULL）时不渲染。
import { Badge } from '@/components/ui';
import { localizedTitle, profileTitle } from '@/services/evidence/control-registry';

interface PolicyProfileBadgeProps {
  /** 活跃版本落库的档案 id。 */
  profile: string | null;
  /** 界面 locale，决定档案标题语言。 */
  locale: string;
  label: string;
}

export function PolicyProfileBadge({ profile, locale, label }: PolicyProfileBadgeProps) {
  if (!profile) return null;
  return (
    <span className="inline-flex items-center gap-2 text-sm" data-testid="policy-profile">
      <span className="text-fg-muted">{label}</span>
      <Badge variant="primary">{localizedTitle(profileTitle(profile), locale)}</Badge>
    </span>
  );
}
