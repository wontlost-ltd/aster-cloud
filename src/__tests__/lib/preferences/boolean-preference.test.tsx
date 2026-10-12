import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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
});
