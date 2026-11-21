/**
 * 策略包导出读取版本显示排版（ADR 0059 修订 4 D11 第 1 步、D13、D16）。
 *
 * 导出是 `loadVersionLayout` 的调用方，但只为把排版作为**非编译载荷**放进包：读取复验（哈希、往返）之后，再用保存时的
 * 同一校验 `prepareLayout`（ts `validatePolicyLayout`，版本 locale 的词法表 + 冻结 aliasSet）复跑一次，通过且开关
 * `policy_export.package.layout.enabled` 打开才随请求发送。任何一步不过都只省略排版（导出 1.0 包），原因写入响应头，
 * 不拒绝导出——排版不改变执行内容（修订 4 §11 Q1）。
 *
 * 排版随版本导出，与导出者有没有结构化编写能力无关（D11 第 4 条）：显示排版对所有有读权限的人可见，导出只是另一种读。
 */
import { isPolicyPackageLayoutExportEnabled } from '@/lib/platform-settings';
import { loadVersionLayout, prepareLayout } from '@/lib/policy-layout/store';
import type { StoredLayout } from '@/lib/policy-layout/types';

export type ExportLayoutOmittedReason = 'layout_inconsistent' | 'layout_invalid' | 'layout_export_disabled';

export type ExportLayout =
  | { kind: 'included'; layout: string }
  | { kind: 'absent' }
  | { kind: 'omitted'; reason: ExportLayoutOmittedReason };

/** 导出所用的版本：源码为实际编译的源码（版本 source，旧版本回退 content），locale / aliasSet 为编译输入。 */
export interface ExportLayoutVersion {
  id: string;
  source: string;
  locale: string;
  aliasSet: Record<string, string[]> | null;
}

const omitted = (reason: ExportLayoutOmittedReason): ExportLayout => ({ kind: 'omitted', reason });

/**
 * 版本无排版为 `absent`（不论开关）；有排版时依次：开关关 → `layout_export_disabled`；读取复验不过或读取出错 →
 * `layout_inconsistent`；保存校验不过 → `layout_invalid`；否则 `included`，文本为存储的规范序列化（`serializeLayout`）。
 */
export async function loadExportLayout(version: ExportLayoutVersion): Promise<ExportLayout> {
  let stored: StoredLayout;
  try {
    stored = await loadVersionLayout(version.id);
  } catch (error) {
    console.error('[package-export-layout] layout read failed; exporting without layout', { versionId: version.id }, error);
    return omitted('layout_inconsistent');
  }
  if (stored.status === 'none') return { kind: 'absent' };
  if (!(await isPolicyPackageLayoutExportEnabled())) return omitted('layout_export_disabled');
  if (stored.status === 'inconsistent') return omitted('layout_inconsistent');
  try {
    const prepared = prepareLayout(stored.layout, {
      source: version.source,
      locale: version.locale,
      aliasSet: version.aliasSet,
    });
    return { kind: 'included', layout: prepared.serialized };
  } catch (error) {
    console.warn('[package-export-layout] layout no longer passes validation; exporting without layout', {
      versionId: version.id,
      code: (error as { code?: unknown } | null)?.code,
    });
    return omitted('layout_invalid');
  }
}
