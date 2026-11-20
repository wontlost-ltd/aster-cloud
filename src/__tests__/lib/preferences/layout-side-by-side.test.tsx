/*
 * 并排视图默认状态的水合行为（ADR 0058 修订 1 A2）：服务端 HTML 与水合首帧都不打开，
 * 水合后才按浏览器偏好决定；存过「关闭」的浏览器全程不出现打开状态。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { LAYOUT_SIDE_BY_SIDE_KEY, useLayoutSideBySide } from '@/lib/preferences/layout-side-by-side';

const roots: Root[] = [];
afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()));
  document.body.innerHTML = '';
  window.localStorage.clear();
});

function Probe({ openByDefault, seen }: { openByDefault: boolean; seen: boolean[] }) {
  const { open } = useLayoutSideBySide(openByDefault);
  seen.push(open);
  return <span>{open ? 'open' : 'closed'}</span>;
}

async function hydrate(openByDefault: boolean): Promise<{ html: string; seen: boolean[]; text: string }> {
  const html = renderToString(<Probe openByDefault={openByDefault} seen={[]} />);
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  const seen: boolean[] = [];
  await act(async () => {
    roots.push(hydrateRoot(container, <Probe openByDefault={openByDefault} seen={seen} />));
  });
  return { html, seen, text: container.textContent ?? '' };
}

describe('useLayoutSideBySide 水合', () => {
  it('缺省（未存偏好）：服务端与水合首帧关闭，水合后打开', async () => {
    const { html, seen, text } = await hydrate(true);
    expect(html).toContain('closed');
    expect(seen[0]).toBe(false);
    expect(text).toBe('open');
  });

  it('存过关闭：全程没有出现打开状态', async () => {
    window.localStorage.setItem(LAYOUT_SIDE_BY_SIDE_KEY, 'false');
    const { seen, text } = await hydrate(true);
    expect(seen.every((v) => v === false)).toBe(true);
    expect(text).toBe('closed');
  });

  it('加载时没有排版：偏好为 true 也保持关闭', async () => {
    window.localStorage.setItem(LAYOUT_SIDE_BY_SIDE_KEY, 'true');
    const { seen, text } = await hydrate(false);
    expect(seen.every((v) => v === false)).toBe(true);
    expect(text).toBe('closed');
  });
});
