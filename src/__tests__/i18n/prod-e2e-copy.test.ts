// 生产 E2E（2026-10-22）文案修复的多语完整性：本轮新增/覆盖的 key 在 en/zh/de/hi 四语
// （内嵌语言包 + 本地补充层合并后）都必须存在且非空；并锁定 F25b 的术语统一。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

type Tree = Record<string, unknown>;

const ROOT = path.resolve(__dirname, '../../..');
const PACKAGE_FILES = {
  en: 'node_modules/@aster-cloud/ui-messages/en-US.json',
  zh: 'node_modules/@aster-cloud/ui-messages/zh-CN.json',
  de: 'node_modules/@aster-cloud/ui-messages/de-DE.json',
  hi: 'node_modules/@aster-cloud/ui-messages-hi/hi-IN.json',
} as const;
type Loc = keyof typeof PACKAGE_FILES;
const LOCALES = Object.keys(PACKAGE_FILES) as Loc[];

function merged(locale: Loc): Tree {
  const read = (l: Loc) => JSON.parse(fs.readFileSync(path.join(ROOT, PACKAGE_FILES[l]), 'utf8')) as Tree;
  // 与 request.ts 同序：en 底座 → 当前语言包 → en 补充 → 当前语言补充；这里只看「当前语言自己有没有」，
  // 故不叠 en 底座，缺译会直接暴露
  return deepMergeMessages(read(locale), DEMO_SUPPLEMENT[locale]);
}

function get(tree: Tree, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((cur, k) => (cur as Tree | undefined)?.[k], tree);
}

const KEYS = [
  // F4 执行日志
  'policies.logs.filtersTitle', 'policies.logs.justNow', 'policies.logs.loadingLogs', 'policies.logs.noLogsHint',
  'policies.logs.parity.tooltip', 'policies.logs.parity.match',
  // F8 Cedar 导出
  'policies.cedarExport.noExecutableVersion', 'policies.detail.versionHistory',
  // F32 回收站 / 确认框
  'policies.trash.confirmPermanentDeleteNamed', 'common.cancel', 'common.confirm', 'common.loading',
  // F25 AHA 卡片
  'dashboard.aha.achievedTitle', 'dashboard.aha.hoursAfterSignup', 'dashboard.aha.achieved', 'dashboard.aha.insideWindow',
  'dashboard.aha.publishFirstTitle', 'dashboard.aha.publishFirstBody', 'dashboard.aha.createPolicy',
  'dashboard.aha.challengeTitle', 'dashboard.aha.challengeBody', 'dashboard.aha.hoursRemaining',
  // F26 两个 API 计量分别命名
  'dashboard.stats.restApiCalls', 'billing.restApiCallsThisMonth', 'billing.policyApiCallsThisMonth',
  // Q1 审批收件箱的策略版本分区
  'approvals.guardTitle', 'approvals.versions.title', 'approvals.versions.subtitle', 'approvals.versions.empty',
  'approvals.versions.thVersion', 'approvals.versions.thSubmitter', 'approvals.versions.thSubmitted',
  'approvals.versions.review', 'approvals.versions.view', 'approvals.versions.awaitingOthers',
  'approvals.versions.unknownUser', 'approvals.thPolicy', 'approvals.thActions',
  // 版本审批权限裁决：个人策略自审说明
  'policies.versions.selfApproveNote', 'policies.versions.awaitingOthers',
];

describe('生产 E2E 文案：四语完整', () => {
  for (const locale of LOCALES) {
    it(`${locale}: 本轮涉及的 key 均存在且非空`, () => {
      const tree = merged(locale);
      const missing = KEYS.filter((k) => {
        const v = get(tree, k);
        return typeof v !== 'string' || v.trim() === '';
      });
      expect(missing).toEqual([]);
    });
  }

  it('非 en 语言的 AHA 卡片文案已翻译（不与 en 相同）', () => {
    const en = merged('en');
    for (const locale of ['zh', 'de', 'hi'] as const) {
      expect(get(merged(locale), 'dashboard.aha.publishFirstBody')).not.toBe(get(en, 'dashboard.aha.publishFirstBody'));
    }
  });
});

describe('zh 笔误覆盖', () => {
  it('sox.selfApprovalNotAllowed 不再出现「请请」', () => {
    const v = get(merged('zh'), 'policies.versions.sox.selfApprovalNotAllowed');
    expect(v).toBe('不能批准自己创建的版本，请其他团队成员审批。');
  });
});

describe('F25b 术语', () => {
  it('hi 导航统一用「AI」，不再出现「एआई」', () => {
    const hi = merged('hi');
    expect(get(hi, 'dashboardNav.aiWorkspace')).toBe('AI कार्यक्षेत्र');
    expect(JSON.stringify(DEMO_SUPPLEMENT.hi)).not.toContain('एआई');
  });

  it('de 的 Policy Execution API 标题已翻译', () => {
    const de = merged('de');
    expect(get(de, 'dashboard.apiUsage.title')).toBe('Policy-Ausführungs-API');
    expect(get(de, 'dashboard.apiUsage.lockedHint')).not.toContain('Policy Execution API');
  });
});
