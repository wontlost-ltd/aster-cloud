'use client';

import { useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';

const EMBED_LOCALES = ['en', 'zh', 'de', 'hi'];
const DEFAULT_BASE = process.env.NEXT_PUBLIC_GUARDIAN_EMBED_URL || 'https://aster-lang.dev/embed/guardian';

export function guardianEmbedUrl(locale: string, theme: 'light' | 'dark', base: string = DEFAULT_BASE): string {
  const loc = EMBED_LOCALES.includes(locale) ? locale : 'en';
  return `${base.replace(/\/+$/, '')}/${loc}?theme=${theme}`;
}

/**
 * AI Guardian 剧情嵌入：先显示静态海报，区块接近视口时才创建 iframe，不影响首屏 LCP。
 */
export function GuardianEmbed({ locale, posterAlt }: { locale: string; posterAlt: string }) {
  const { resolvedTheme } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        io.disconnect();
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const theme = resolvedTheme === 'dark' ? 'dark' : 'light';
  return (
    <div ref={box} className="relative aspect-[16/10] w-full overflow-hidden rounded-xl border border-border bg-bg-muted">
      {visible ? (
        <iframe title={posterAlt} src={guardianEmbedUrl(locale, theme)} className="h-full w-full" loading="lazy" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- 静态海报占位，尺寸固定，无需 next/image 优化管线
        <img src="/images/guardian-poster.webp" alt={posterAlt} className="h-full w-full object-cover" width={1280} height={800} />
      )}
    </div>
  );
}
