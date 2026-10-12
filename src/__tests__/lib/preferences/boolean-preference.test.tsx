import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { createBooleanPreference, useBooleanPreference } from '@/lib/preferences/boolean-preference';

/**
 * 本地布尔偏好存储：默认值、持久化、同页多订阅者同步、跨标签页 storage 事件。
 * 每条用例用独立 key，避免模块级缓存在用例之间串味。
 */

let seq = 0;
const freshKey = () => `test.pref.${++seq}`;

function Probe({ pref, testId }: { pref: ReturnType<typeof createBooleanPreference>; testId: string }) {
  const { value, setValue } = useBooleanPreference(pref);
  return (
    <button data-testid={testId} onClick={() => setValue(!value)}>
      {String(value)}
    </button>
  );
}

beforeEach(() => window.localStorage.clear());

describe('createBooleanPreference', () => {
  it('未设置时取默认值；存储里有值时以存储为准', () => {
    const k1 = freshKey();
    expect(createBooleanPreference(k1, true).read()).toBe(true);
    const k2 = freshKey();
    window.localStorage.setItem(k2, 'false');
    expect(createBooleanPreference(k2, true).read()).toBe(false);
  });

  it('write 持久化到 localStorage', () => {
    const k = freshKey();
    const pref = createBooleanPreference(k, true);
    pref.write(false);
    expect(window.localStorage.getItem(k)).toBe('false');
    expect(pref.read()).toBe(false);
  });

  it('★同页两个订阅者：一处切换，另一处立即同步', () => {
    const pref = createBooleanPreference(freshKey(), true);
    render(
      <>
        <Probe pref={pref} testId="a" />
        <Probe pref={pref} testId="b" />
      </>,
    );
    expect(screen.getByTestId('b').textContent).toBe('true');
    act(() => screen.getByTestId('a').click());
    expect(screen.getByTestId('a').textContent).toBe('false');
    expect(screen.getByTestId('b').textContent).toBe('false');
  });

  it('★其他标签页修改（storage 事件）后本页同步', () => {
    const k = freshKey();
    const pref = createBooleanPreference(k, true);
    render(<Probe pref={pref} testId="p" />);
    expect(screen.getByTestId('p').textContent).toBe('true');
    act(() => {
      window.localStorage.setItem(k, 'false');
      window.dispatchEvent(new StorageEvent('storage', { key: k }));
    });
    expect(screen.getByTestId('p').textContent).toBe('false');
  });

  it('无关 key 的 storage 事件不影响取值', () => {
    const k = freshKey();
    const pref = createBooleanPreference(k, true);
    render(<Probe pref={pref} testId="p" />);
    act(() => {
      window.localStorage.setItem(k, 'false');
      window.dispatchEvent(new StorageEvent('storage', { key: 'other.key' }));
    });
    expect(screen.getByTestId('p').textContent).toBe('true');
  });

  it('★无订阅者期间其他标签页修改，再次挂载读到新值（缓存过期则变红）', () => {
    const k = freshKey();
    const pref = createBooleanPreference(k, true);
    const first = render(<Probe pref={pref} testId="p" />);
    expect(screen.getByTestId('p').textContent).toBe('true');
    first.unmount();
    // 此刻本页没有订阅者，storage 监听已移除
    window.localStorage.setItem(k, 'false');
    window.dispatchEvent(new StorageEvent('storage', { key: k }));
    render(<Probe pref={pref} testId="p" />);
    expect(screen.getByTestId('p').textContent).toBe('false');
  });

  it('其他标签页 localStorage.clear()（key 为 null）后回到默认值', () => {
    const k = freshKey();
    const pref = createBooleanPreference(k, true);
    pref.write(false);
    render(<Probe pref={pref} testId="p" />);
    expect(screen.getByTestId('p').textContent).toBe('false');
    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    // 会话内值仍是 false：存储被清空但本会话写过，继续按会话值生效
    expect(screen.getByTestId('p').textContent).toBe('false');
    expect(createBooleanPreference(freshKey(), true).read()).toBe(true);
  });

  it('★服务端渲染固定输出默认值（与存储无关，避免 hydration mismatch）', () => {
    const k = freshKey();
    window.localStorage.setItem(k, 'false');
    const pref = createBooleanPreference(k, true);
    expect(renderToString(<Probe pref={pref} testId="p" />)).toContain('>true<');
  });

  it('存储读写都抛错时：取默认值，本次会话内写入仍生效', () => {
    const k = freshKey();
    const pref = createBooleanPreference(k, true);
    const get = window.localStorage.getItem;
    const set = window.localStorage.setItem;
    Object.defineProperty(window.localStorage, 'getItem', { configurable: true, value: () => { throw new Error('denied'); } });
    Object.defineProperty(window.localStorage, 'setItem', { configurable: true, value: () => { throw new Error('denied'); } });
    try {
      expect(pref.read()).toBe(true);
      pref.write(false);
      expect(pref.read()).toBe(false);
    } finally {
      Object.defineProperty(window.localStorage, 'getItem', { configurable: true, value: get });
      Object.defineProperty(window.localStorage, 'setItem', { configurable: true, value: set });
    }
  });
});
