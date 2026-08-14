// 仪表盘 Quick Action 的文案必须与 /reports 的**实际能力**一致。
//
// ## 被修复的问题
//
// 包内原文是 “Generate Report” / “GDPR, HIPAA, SOC2”，而实测：
//   · HIPAA / SOC2 在全仓**零实现**（grep 无任何命中）；
//   · GDPR 只存在于 /settings/data（DSAR Art 15/17），与本入口指向的
//     /reports 是**两个不同页面**。
//
// /reports 实际产出的是**决策证据包**——页面自己的文案就写着
// “No fabricated compliance score and no boilerplate regulation advice”。
// #253 把该页从假合规分改成真证据导出时，漏改了仪表盘入口，
// 于是仪表盘仍在向外部用户承诺三套合规框架。
//
// 在信贷风控领域「我们支持 SOC2」是有法律分量的说法，不能停留在文案层。
//
// ## 这个测试守什么
//
// 守「**不得再出现未实现的合规框架名**」这条事实约束，而不是钉死某句具体措辞
// ——后者会让任何正常的文案润色都变成红灯，久而久之被人删掉。

import { describe, it, expect } from 'vitest';

import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

import pkgEn from '@aster-cloud/ui-messages/en-US.json';

type Tree = Record<string, unknown>;

const LOCALES = ['en', 'zh', 'de', 'hi'] as const;

/** 未实现的合规框架名——出现在用户可见文案里即为不实承诺。 */
const UNIMPLEMENTED_FRAMEWORKS = [/HIPAA/i, /SOC\s*-?2/i];

function quickActions(locale: (typeof LOCALES)[number]): Tree {
  const sup = (DEMO_SUPPLEMENT as Record<string, Tree>)[locale] ?? {};
  const dash = (sup.dashboard ?? {}) as Tree;
  return (dash.quickActions ?? {}) as Tree;
}

describe('Quick Action「导出证据」文案', () => {
  it.each(LOCALES)('[%s] 不得宣称未实现的合规框架', (locale) => {
    const q = quickActions(locale);
    const text = `${String(q.generateReport ?? '')} ${String(q.generateReportDesc ?? '')}`;

    for (const re of UNIMPLEMENTED_FRAMEWORKS) {
      expect(text, `★"${text}" 含未实现的合规框架名`).not.toMatch(re);
    }
  });

  it.each(LOCALES)('[%s] 四个 locale 都必须覆盖，不能只改英文', (locale) => {
    const q = quickActions(locale);
    expect(q.generateReport, '缺 generateReport 覆盖').toBeTruthy();
    expect(q.generateReportDesc, '缺 generateReportDesc 覆盖').toBeTruthy();
  });

  it('★深合并只改这两个 key，不得吞掉同级的其它 quickActions', () => {
    // 本地补充层用的是 deepMergeMessages。若写成整对象替换，
    // createPolicy / apiKeys 会被静默删掉，仪表盘少两个卡片——
    // 这类「修 A 弄坏 B」正是本仓反复出现的形态，故显式钉住。
    const merged = deepMergeMessages(
      pkgEn as unknown as Tree,
      (DEMO_SUPPLEMENT as Record<string, Tree>).en,
    ) as Tree;
    const q = ((merged.dashboard as Tree).quickActions ?? {}) as Tree;

    expect(q.createPolicy).toBeTruthy();
    expect(q.apiKeys).toBeTruthy();
    expect(q.title).toBeTruthy();
    // 目标 key 确实被改写了（否则本测试只是在验证包内原文）
    expect(String(q.generateReportDesc)).not.toMatch(/HIPAA|SOC/i);
  });
});
