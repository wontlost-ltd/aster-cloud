import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 已信任设备「最近使用」（F22）。
 *
 * 生产缺陷：正在使用的设备显示「最近使用：从未」。lastUsedAt 只在「凭可信设备跳过
 * 二次验证」时写入，签发时不写，而 7 天 session 内不会再走登录——于是当前设备一直是 null。
 * 修复：签发即写入；设备列表接口按 cookie 识别当前设备，并节流（1 小时）刷新。
 */

const { rows, updates, inserts } = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updates.push(v);
        return { where: () => Promise.resolve() };
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserts.push(v);
        return Promise.resolve();
      },
    }),
  }),
}));

import {
  LAST_USED_TOUCH_INTERVAL_MS,
  issueTrustedDevice,
  listTrustedDevices,
  shouldTouchLastUsed,
} from '@/lib/trusted-device';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const TOKEN = 'a'.repeat(64);

function device(id: string, token: string, lastUsedAt: Date | null) {
  return {
    id,
    tokenHash: sha(token),
    label: 'Chrome on macOS',
    lastUsedAt,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    expires: new Date('2026-10-31T00:00:00Z'),
  };
}

beforeEach(() => {
  rows.length = 0;
  updates.length = 0;
  inserts.length = 0;
});

describe('shouldTouchLastUsed', () => {
  it('从未记录 → 需要刷新', () => {
    expect(shouldTouchLastUsed(null, NOW)).toBe(true);
  });
  it('间隔内 → 不刷新（节流）', () => {
    expect(shouldTouchLastUsed(new Date(NOW.getTime() - 60_000), NOW)).toBe(false);
  });
  it('超过间隔 → 刷新', () => {
    expect(shouldTouchLastUsed(new Date(NOW.getTime() - LAST_USED_TOUCH_INTERVAL_MS), NOW)).toBe(
      true,
    );
  });
});

describe('issueTrustedDevice', () => {
  it('★签发时即写入 lastUsedAt（这台设备此刻正在使用）', async () => {
    await issueTrustedDevice('u1', 'Mozilla/5.0 Chrome/120', NOW);
    expect(inserts[0].lastUsedAt).toEqual(NOW);
  });
});

describe('listTrustedDevices', () => {
  it('★按 cookie 标记当前设备，并刷新从未记录的 lastUsedAt', async () => {
    rows.push(device('d1', TOKEN, null), device('d2', 'b'.repeat(64), null));
    const list = await listTrustedDevices('u1', NOW, TOKEN);
    expect(list.map((d) => [d.id, d.current])).toEqual([
      ['d1', true],
      ['d2', false],
    ]);
    expect(list[0].lastUsedAt).toEqual(NOW);
    expect(list[1].lastUsedAt).toBeNull();
    expect(updates).toEqual([{ lastUsedAt: NOW }]);
  });

  it('节流：当前设备 1 小时内已刷新过就不再写库', async () => {
    const recent = new Date(NOW.getTime() - 5 * 60_000);
    rows.push(device('d1', TOKEN, recent));
    const list = await listTrustedDevices('u1', NOW, TOKEN);
    expect(list[0].current).toBe(true);
    expect(list[0].lastUsedAt).toEqual(recent);
    expect(updates).toEqual([]);
  });

  it('没有 cookie → 不标记、不写库；结果不含 tokenHash', async () => {
    rows.push(device('d1', TOKEN, null));
    const list = await listTrustedDevices('u1', NOW, null);
    expect(list[0].current).toBe(false);
    expect(updates).toEqual([]);
    expect(list[0]).not.toHaveProperty('tokenHash');
  });
});
