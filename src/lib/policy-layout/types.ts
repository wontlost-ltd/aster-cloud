/**
 * 版本 LayoutMap 的读取契约（ADR 0058 §7.2）。客户端组件可用：只含类型。
 *
 * - `none`：该版本没有 layout。
 * - `ok`：layout 行存在且读取时复验（哈希、往返）全部通过。
 * - `inconsistent`：layout 行存在但复验不过（直接改库、resolver 迁移改了源码等）。读接口仍 200，
 *   视图只显示 canonical 与提示，编辑器不加载，下次保存不沿用。
 */
import type { PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';

export type StoredLayout =
  | { status: 'none' }
  | { status: 'ok'; layout: PolicyLayout; layoutSha256: string }
  | { status: 'inconsistent'; layoutSha256: string };
