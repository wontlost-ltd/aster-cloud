// 团队流程修复（#672 #675 #676 #677 #678 #680 #681 #682）新增 / 覆盖的文案：en/zh/de/hi 四语
// （内嵌语言包 + 本地补充层合并后）都必须存在且非空；团队流程文案不得在非中文语言里出现中文（#680）。

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
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, PACKAGE_FILES[locale]), 'utf8')) as Tree;
  return deepMergeMessages(pkg, DEMO_SUPPLEMENT[locale]);
}

function get(tree: Tree, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((cur, k) => (cur as Tree | undefined)?.[k], tree);
}

const KEYS = [
  'auth.signup.errors.emailAliasRegisteredAs',
  'approvals.errors.approval_not_found',
  'approvals.errors.receipt_unavailable',
  'approvals.errors.invalid_approval',
  'approvals.errors.user_required',
  'teams.settings.transferPlanNote',
  'teams.settings.transferErrors.newOwnerPlanIneligible',
  'teams.settings.transferErrors.newOwnerSeatLimit',
  'teams.settings.deleteTeamDescription',
  'teams.settings.deleteWarning1',
  'security.eventTypes.TEAM_MEMBER_BUSINESS_ROLES_UPDATED',
  'teams.members.roleSelectLabel',
  'auth.signup.errors.emailAlreadyRegistered',
  'auth.signup.errors.emailAliasRegistered',
  'auth.signup.forgotPassword',
  'notifications.versionSubmitted',
  'notifications.versionApproved',
  'notifications.versionRejected',
  'notifications.versionRejectedNoComment',
  'policies.versions.rejectionReason',
  'policies.detail.teamBadge',
  'teams.acceptInvite.joiningTeam',
  'teams.acceptInvite.emailMismatch',
  'teams.policies.executionCount',
  'teams.policies.unknownCreator'
];

describe('团队流程文案四语完整性', () => {
  for (const locale of LOCALES) {
    it(`${locale}：新增键都存在且非空`, () => {
      const tree = merged(locale);
      const missing = KEYS.filter((k) => {
        const v = get(tree, k);
        return typeof v !== 'string' || v.trim() === '';
      });
      expect(missing).toEqual([]);
    });
  }

  it('非中文语言不含中文字符', () => {
    for (const locale of ['en', 'de', 'hi'] as const) {
      const tree = merged(locale);
      const withCjk = KEYS.filter((k) => /[\u4e00-\u9fff]/.test(String(get(tree, k))));
      expect(withCjk, locale).toEqual([]);
    }
  });

  it('审查 L3：转让说明写明付费席位不会自动迁移', () => {
    expect(String(get(merged('en'), 'teams.settings.transferPlanNote'))).toMatch(/not moved automatically/);
    expect(String(get(merged('zh'), 'teams.settings.transferPlanNote'))).toMatch(/不会自动迁移/);
  });

  it('#675 删除团队的确认文案如实说明团队策略转为创建者的个人策略', () => {
    expect(String(get(merged('en'), 'teams.settings.deleteWarning1'))).toMatch(/personal policy/);
    expect(String(get(merged('zh'), 'teams.settings.deleteWarning1'))).toMatch(/个人策略/);
  });
});
