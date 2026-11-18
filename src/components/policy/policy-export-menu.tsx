'use client';

/*
 * 策略详情页操作组里的「导出」（ADR 0059 P2，T19）。
 *
 * - 没有任何包选项时（开关关、套餐不允许、无已批准版本，或两个 target 都不可用）：只有 Cedar 时保持原来的
 *   「导出为 Cedar」单按钮，DOM 与引入本组件之前相同；Cedar 也不可见时什么都不渲染。
 * - 有包选项时：按钮变为「导出」下拉，依次是 Cedar（可见时）、JRE 包、Node 包，每项一行说明。
 *   - exportable / unknown：可选，选中即导出（unknown 照常显示，由导出本身说明原因，同 #786）；
 *   - not-exportable：aria-disabled，说明行为「无法导出 · 查看原因」，选中后在状态区列出 check 给出的诊断；
 *   - unavailable：不显示。
 * 无障碍沿用 #779–#790 的约定：下拉是 disclosure（Esc 与选中后焦点回到触发按钮，见 ui/dropdown），
 * 菜单项高度 ≥ 44px（两行内容 + 内边距），忙碌时 aria-busy 且按钮宽度不变，可访问名即可见文字。
 */
import { useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { Dropdown, DropdownItem } from '@/components/ui/dropdown';
import { CedarExportButton, NO_VERSION_HINT_ID, useOptionalCedarExport } from '@/components/policy/cedar-export-panel';
import { useOptionalPackageExport, type PackageExportLabels } from '@/components/policy/package-export-panel';
import type { PackageExportMenuState } from '@/lib/package-export-state';
import type { PackageExportTarget } from '@/services/policy/policy-api';

interface PolicyExportMenuProps {
  /** Cedar 是否可见（服务端按可导出性判定，#786） */
  showCedar: boolean;
  /** 包选项状态；null 表示没有任何包选项 */
  packages: PackageExportMenuState | null;
  labels: PackageExportLabels;
}

const TARGETS: readonly PackageExportTarget[] = ['jre', 'node'];

/** 菜单里要显示的包项（unavailable 不显示） */
export function visiblePackageTargets(packages: PackageExportMenuState | null): PackageExportTarget[] {
  return packages ? TARGETS.filter((t) => packages[t] !== 'unavailable') : [];
}

const ITEM_CLASS = 'min-h-11 py-2.5';

function ItemText({ title, hint, hintId }: { title: string; hint: string; hintId?: string }) {
  return (
    <>
      <span className="block font-medium">{title}</span>
      <span id={hintId} className="mt-0.5 block text-xs text-fg-muted">{hint}</span>
    </>
  );
}

function CedarItem({ labels }: { labels: PackageExportLabels }) {
  const cedar = useOptionalCedarExport();
  if (!cedar) return null;
  const busy = cedar.state.kind === 'busy';
  return (
    <DropdownItem
      onSelect={() => cedar.handleExport()}
      disabled={busy || !cedar.hasExecutableVersion}
      aria-describedby={cedar.hasExecutableVersion ? undefined : NO_VERSION_HINT_ID}
      data-testid="export-item-cedar"
      className={ITEM_CLASS}
    >
      <ItemText title={labels.cedarItem} hint={labels.cedarHint} />
    </DropdownItem>
  );
}

function PackageItem({ target, labels }: { target: PackageExportTarget; labels: PackageExportLabels }) {
  const pkg = useOptionalPackageExport();
  const hintId = useId();
  if (!pkg) return null;
  const blocked = pkg.packages[target] === 'not-exportable';
  const title = target === 'jre' ? labels.jreItem : labels.nodeItem;
  const hint = blocked ? `${labels.notExportable} · ${labels.showReasons}` : target === 'jre' ? labels.jreHint : labels.nodeHint;
  return (
    <DropdownItem
      // 不可导出的项仍可聚焦与选中（选中即查看原因），故用 aria-disabled 而非 disabled
      onSelect={() => (blocked ? pkg.showReasons(target) : pkg.startExport(target))}
      disabled={pkg.state.kind === 'busy'}
      aria-disabled={blocked || undefined}
      aria-describedby={hintId}
      data-testid={`export-item-${target}`}
      data-state={pkg.packages[target]}
      className={`${ITEM_CLASS} ${blocked ? 'text-fg-muted' : ''}`}
    >
      <ItemText title={title} hint={hint} hintId={hintId} />
    </DropdownItem>
  );
}

/** 触发按钮必须是原生 button 元素：Dropdown 克隆它并注入 onClick 与 aria-expanded */
function menuTrigger(labels: PackageExportLabels, busy: boolean) {
  return (
    <button
      type="button"
      aria-busy={busy || undefined}
      data-testid="policy-export-menu-button"
      className="inline-flex items-center gap-1 rounded-md bg-bg px-3 py-2 text-sm font-semibold text-fg shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-bg-subtle"
    >
      {/* 两段文案叠在同一格里、只显示其一：导出中切换文案时同组按钮不移位 */}
      <span className="grid">
        <span className={`col-start-1 row-start-1 ${busy ? 'invisible' : ''}`}>{labels.menu}</span>
        <span className={`col-start-1 row-start-1 ${busy ? '' : 'invisible'}`} aria-hidden="true">{labels.exporting}</span>
      </span>
      <ChevronDown className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

export function PolicyExportMenu({ showCedar, packages, labels }: PolicyExportMenuProps) {
  const cedar = useOptionalCedarExport();
  const pkg = useOptionalPackageExport();
  const targets = visiblePackageTargets(packages);
  if (targets.length === 0) return showCedar ? <CedarExportButton /> : null;
  const busy = cedar?.state.kind === 'busy' || pkg?.state.kind === 'busy';
  return (
    <Dropdown trigger={menuTrigger(labels, busy)} className="w-72" align="right">
      {showCedar && <CedarItem labels={labels} />}
      {targets.map((target) => <PackageItem key={target} target={target} labels={labels} />)}
    </Dropdown>
  );
}
