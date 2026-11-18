// 策略包导出组件测试共用的英文文案（ADR 0059 P2）。
import type { PackageExportLabels } from '@/components/policy/package-export-panel';

export const packageExportLabels: PackageExportLabels = {
  menu: 'Export', cedarItem: 'Cedar policy', cedarHint: 'For a gateway', jreItem: 'Policy package (JRE)', jreHint: 'Needs Java 25',
  nodeItem: 'Policy package (Node)', nodeHint: 'Needs Node 24', exporting: 'Exporting…', downloaded: 'Downloaded. SHA-256: {sha256}',
  unsigned: 'Not signed', notExportable: "Can't be exported", showReasons: 'Show reasons', chooseEntry: 'Choose the entry',
  exportEntry: 'Export this entry', planRequired: 'Paid plan required', busy: 'Busy', unavailable: 'Unavailable', failed: 'Failed',
  noExecutableVersion: 'Approve first', copy: 'Copy SHA-256', copied: 'Copied',
  reasons: { E730: 'Uses IO', E734: 'Too large', other: 'Other reason' },
};
