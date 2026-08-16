// 可信设备标签的浏览器/系统识别（issue #400）。
//
// ## 由来：用户报告的真实 bug
//
// 「Chrome on iOS」被记成了「Safari on macOS」——**两个字段同时错**，
// 而原有测试只覆盖了一种 UA（Chrome on macOS），故完全没有报红。
//
// 两个独立根因：
//   1. Apple 规定 iOS 上所有浏览器必须用 WebKit，因此 iOS 版 Chrome/Firefox/Edge
//      的 UA 里**没有** `Chrome/`、`Firefox/`，只有 `CriOS/`、`FxiOS/`、`EdgiOS/`，
//      且都带 `Safari/` → 只测 `Chrome\/` 会漏判并落到 Safari 分支。
//   2. iOS 的 UA 含字面量 `like Mac OS X`，而 `/Mac OS X/` 的判定排在
//      `/iPhone|iPad/` **之前** → 每一台 iOS 设备都被记成 macOS。
//
// ## 为什么用真实 UA 表驱动
//
// 这个函数的全部难点就在于「真实世界的 UA 不讲道理」。用编造的字符串测
// 等于测自己的想象；下面每一条都是各浏览器实际发出的形态。
// 标签会展示在「可信设备」列表里，用户据此判断"这台还是不是我"——
// 认错设备会让他要么误删自己的设备，要么把陌生设备当成自己的。

import { describe, it, expect } from 'vitest';

import { coarseLabel } from '@/lib/trusted-device';

const CASES: Array<[string, string, string]> = [
  // ── iOS：全部走 WebKit，靠专属标记区分 ──────────────────────────
  [
    'Chrome on iOS',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
    'Chrome on iOS',
  ],
  [
    'Safari on iOS',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Safari on iOS',
  ],
  [
    'Firefox on iOS',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
    'Firefox on iOS',
  ],
  [
    'Edge on iOS',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/126.0 Mobile/15E148 Safari/605.1.15',
    'Edge on iOS',
  ],
  [
    'Safari on iPad',
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Safari on iOS',
  ],
  // ── macOS ────────────────────────────────────────────────────────
  [
    'Safari on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Safari on macOS',
  ],
  [
    'Chrome on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36',
    'Chrome on macOS',
  ],
  // ── Windows ──────────────────────────────────────────────────────
  [
    'Edge on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87',
    'Edge on Windows',
  ],
  [
    'Chrome on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Chrome on Windows',
  ],
  [
    'Firefox on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Firefox on Windows',
  ],
  // ── Android：UA 里含 Linux，故 Android 必须排在 Linux 之前 ────────
  [
    'Chrome on Android',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36',
    'Chrome on Android',
  ],
  [
    'Firefox on Android',
    'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
    'Firefox on Android',
  ],
  // ── Linux ────────────────────────────────────────────────────────
  [
    'Firefox on Linux',
    'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Firefox on Linux',
  ],
];

describe('可信设备标签识别（issue #400）', () => {
  it.each(CASES)('%s', (_name, ua, expected) => {
    expect(coarseLabel(ua)).toBe(expected);
  });

  it('★iOS 不得被认成 macOS（用户报告的 bug 的一半）', () => {
    // iOS 的 UA 里含字面量 "like Mac OS X"，先测 /Mac OS X/ 就会全军覆没。
    const iosUas = CASES.filter(([n]) => n.includes('iOS') || n.includes('iPad'));
    expect(iosUas.length).toBeGreaterThan(3);
    for (const [name, ua] of iosUas) {
      expect(coarseLabel(ua), `${name} 被认成了 macOS`).toContain('on iOS');
    }
  });

  it('★iOS 上的 Chrome 不得被认成 Safari（另一半）', () => {
    const ua = CASES.find(([n]) => n === 'Chrome on iOS')![1];
    expect(coarseLabel(ua)).not.toContain('Safari');
  });

  it('空 UA 返回 null（不编造标签）', () => {
    expect(coarseLabel(null)).toBeNull();
    expect(coarseLabel(undefined)).toBeNull();
    expect(coarseLabel('')).toBeNull();
  });

  it('★不落完整 UA——标签只是粗粒度描述', () => {
    // 完整 UA 接近指纹（版本号+引擎+机型足以缩小到很小人群）。
    const ua = CASES.find(([n]) => n === 'Chrome on macOS')![1];
    const label = coarseLabel(ua)!;
    expect(label).not.toContain('537.36');
    expect(label.length).toBeLessThan(32);
  });
});
