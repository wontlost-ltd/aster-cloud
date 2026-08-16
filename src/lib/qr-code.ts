/**
 * TOTP 二维码渲染 —— 输出内联 SVG（issue #400）。
 *
 * <h2>选型经过（留档，避免将来重走弯路）</h2>
 *
 * 初版**手写**了一个 QR 编码器（GF(256) 运算 + Reed-Solomon + 掩码 + 版本 6
 * 的固定布局），动机是「零依赖 + CSP 友好」，与仓内 equivalence 趋势图
 * 手写 SVG 的做法一致。
 *
 * 但真实的 `otpauth://` URI 实测 **114 字节**，超出 Version 6 ECC-M 的 106 字节容量；
 * 而支持 Version 7 以上需要额外实现版本信息块、多种分块结构与掩码择优——
 * 那是一个完整子系统，且**错了会静默产出扫不出来的图**（二维码的失败模式
 * 恰恰是最难自测的：肉眼看着像模像样，手机就是不认）。
 *
 * 故改用 `uqr`：**零运行时依赖**、ESM、专为各种 runtime（含 edge）设计，
 * 直接输出 SVG 字符串。既守住了「不引入重依赖 / 不用 canvas / 不发外部请求」
 * 的原始意图，又不必自己承担 QR 规范的正确性风险。
 *
 * ★仍然保持的性质：
 *   - 输出**内联 SVG**，无外部资源、无 `data:` 图片、无 canvas → CSP 友好
 *   - 纯字符串运算，Workers 可用
 */

import { renderSVG } from 'uqr';

/**
 * 把文本渲染成内联 SVG 二维码。
 *
 * <p>★保留静区（quiet zone）：扫描器依赖它定位，省掉会导致部分 App 扫不出来。
 * uqr 默认带 border，此处显式写出以免将来被人"优化"掉。
 */
export function renderQrSvg(text: string): string {
  const svg = renderSVG(text, {
    border: 4,
    pixelSize: 6,
    whiteColor: '#ffffff',
    blackColor: '#000000',
  });

  // ★必须补上 width/height（用户报告：二维码"元素在页面上但看不见"）。
  //   uqr 只输出 `viewBox`，**不输出 width/height**——这样的 SVG 没有固有尺寸，
  //   放进 `w-fit` / flex 之类"由内容决定宽度"的容器里会塌缩成 0×0：
  //   元素在 DOM 里、检查器里也能选中，但一个像素都画不出来。
  //
  //   ★这也是我上一轮验证的盲区：当时是把**模块矩阵**取出来重绘成像素再解码，
  //   证明了"编码正确"，却完全没有走到"这段 SVG 在浏览器里长什么样"。
  //   编码正确 ≠ 能看见。
  const size = /viewBox="0 0 (\d+)/.exec(svg)?.[1];
  if (!size) return svg;
  return svg.replace(
    '<svg ',
    `<svg width="${size}" height="${size}" `,
  );
}
