/**
 * 公开营销页的轻量顶栏：Logo（回首页）+ 语言切换 + 登录。
 *
 * /solutions/* 与 /equivalence 共用；首页有自己的完整导航（含锚点与 CTA），不使用本组件。
 */
import { Link } from '@/i18n/navigation';
import { LanguageSwitcher } from '@/components/language-switcher';
import { Container, Stack, Wordmark } from '@/components/ui';

/**
 * 同步组件、文案由调用方传入：可在服务端组件内直接内联渲染，单测也能整树同步渲染。
 */
export function PublicTopBar({ brandLabel, signInLabel }: { brandLabel: string; signInLabel: string }) {
  return (
    <header className="border-b border-border bg-bg/80 backdrop-blur-md">
      <Container size="xl">
        <div className="flex h-16 items-center justify-between gap-4">
          <Link href="/" aria-label={brandLabel} className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="" aria-hidden className="h-8 w-8 shrink-0" />
            <span className="hidden sm:inline">
              <Wordmark variant="product" size="md" />
            </span>
          </Link>
          <Stack direction="row" gap={4} align="center">
            <LanguageSwitcher allowedLocales={null} />
            <Link href="/login" className="text-sm font-medium text-fg-muted transition-colors hover:text-fg">
              {signInLabel}
            </Link>
          </Stack>
        </div>
      </Container>
    </header>
  );
}
