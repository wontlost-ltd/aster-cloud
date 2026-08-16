// 二维码 SVG 的**可见性**契约（issue #400）。
//
// ## 由来：用户报告「元素在页面上，但二维码看不见」
//
// 根因是 `uqr` 只输出 `viewBox`，**不输出 width/height**。这样的 SVG 没有
// 固有尺寸，放进 `w-fit` / flex 这类"由内容决定宽度"的容器里会塌缩成 0×0——
// DOM 里有、检查器能选中、一个像素也画不出来。
//
// ## 我上一轮验证为什么没抓到
//
// 当时是把**模块矩阵**取出来重绘成像素、再用 jsQR 解码，证明了"编码正确"。
// 但那条路径完全绕开了「这段 SVG 在浏览器里长什么样」。
// **编码正确 ≠ 能看见**——本文件补的就是后半句。

import { describe, it, expect } from 'vitest';

import { renderQrSvg } from '@/lib/qr-code';

const URI =
  'otpauth://totp/Aster%20Cloud:someone%40example.com?secret=JBSWY3DPEHPK3PXPKRSXG5BAMFXG2ZLO&issuer=Aster%20Cloud';

describe('二维码 SVG 渲染（issue #400）', () => {
  it('★必须带 width/height——只有 viewBox 会在 w-fit 容器里塌缩成 0×0', () => {
    const svg = renderQrSvg(URI);
    expect(svg, '缺 width → 无固有尺寸 → 用户看不见二维码').toMatch(
      /<svg[^>]*\swidth="\d+"/,
    );
    expect(svg).toMatch(/<svg[^>]*\sheight="\d+"/);
  });

  it('★width/height 必须与 viewBox 一致（否则会被拉伸变形、扫不出来）', () => {
    const svg = renderQrSvg(URI);
    const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    const w = /<svg[^>]*\swidth="(\d+)"/.exec(svg);
    const h = /<svg[^>]*\sheight="(\d+)"/.exec(svg);
    expect(box).toBeTruthy();
    expect(w![1]).toBe(box![1]);
    expect(h![1]).toBe(box![2]);
  });

  it('尺寸必须是正数且足够大（太小手机扫不出来）', () => {
    const svg = renderQrSvg(URI);
    const w = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svg)![1]);
    expect(w).toBeGreaterThan(100);
  });

  it('★保持内联、无外部资源——CSP 友好是选它不选图片的理由', () => {
    const svg = renderQrSvg(URI);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('data:');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('href');
  });

  it('★内容不回显用户可控文本（email 出现在 URI 里）', () => {
    // email 已被 QR 编码成图形模块，不该以原文出现在 SVG 里。
    const svg = renderQrSvg(
      'otpauth://totp/Aster:%3Cscript%3E@x.com?secret=JBSWY3DPEHPK3PXP',
    );
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('@x.com');
  });
});
