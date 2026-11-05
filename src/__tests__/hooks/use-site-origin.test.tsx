/**
 * 登录页 SSR 拿不到浏览器 origin（#714 / cloud#713 O1）：服务端与客户端首帧必须一致，
 * 否则同源绝对 callbackUrl 时「注册」链接 href 会 hydration 不一致并丢失 callbackUrl。
 * useSiteOrigin 用 useSyncExternalStore：服务端快照与 hydration 首帧都是 undefined，
 * hydration 完成后再切到 window.location.origin。
 */
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useSiteOrigin } from '@/hooks/use-site-origin';
import { safeRedirectPath } from '@/lib/safe-redirect';

function SignupLink({ raw }: { raw: string }) {
  const origin = useSiteOrigin();
  const cb = safeRedirectPath(raw, null, origin);
  return <a href={cb ? `/signup?callbackUrl=${encodeURIComponent(cb)}` : '/signup'}>signup</a>;
}

describe('useSiteOrigin', () => {
  it('服务端渲染时为 undefined', () => {
    const html = renderToString(<SignupLink raw={`${window.location.origin}/policies/1`} />);
    expect(html).toContain('href="/signup"');
  });

  it('hydration 无不一致，完成后链接带上同源 callbackUrl', async () => {
    const raw = `${window.location.origin}/policies/1`;
    const container = document.createElement('div');
    container.innerHTML = renderToString(<SignupLink raw={raw} />);
    document.body.appendChild(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const recoverable = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(container, <SignupLink raw={raw} />, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(container.querySelector('a')!.getAttribute('href')).toBe(
      `/signup?callbackUrl=${encodeURIComponent('/policies/1')}`,
    );
    errSpy.mockRestore();
    container.remove();
  });

  it('登录页用 useSiteOrigin，不再在渲染期读 typeof window', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../app/[locale]/(auth)/login/login-content.tsx'),
      'utf8',
    );
    expect(src).toMatch(/useSiteOrigin\(\)/);
    expect(src).not.toMatch(/typeof window === 'undefined' \? undefined : window\.location\.origin/);
  });
});
