/**
 * 把版本的显示排版与调用处实际显示的 canonical 文本对齐（ADR 0058 §7.2 读取契约的补充）。
 *
 * 存储层按版本源码复验；而某些视图显示的 canonical 来自别处（策略详情页显示 `Policy.content`）。
 * 两者若对不上（resolver 迁移、直接改库），按 `inconsistent` 处理：只显示 canonical 与提示，绝不显示过期排版。
 * 纯函数，客户端与服务端都可用。
 */
import { toCanonical } from '@aster-cloud/aster-lang-ts/layout';
import type { StoredLayout } from './types';

export function layoutForCanonical(layout: StoredLayout, canonical: string): StoredLayout {
  if (layout.status !== 'ok' || toCanonical(layout.layout) === canonical) return layout;
  return { status: 'inconsistent', layoutSha256: layout.layoutSha256 };
}
