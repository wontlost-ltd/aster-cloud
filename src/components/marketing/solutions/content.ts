/**
 * 需求验证落地页的结构配置：每页引用哪些事实（来源链接不随语种变化，放在代码里）、
 * 列出哪些「现已可用」与「开发中 / 试点」条目。文案本身在 i18n 补充层 `solutionsPage.pages.<key>.*`。
 *
 * 口径约束（产品方向 2026-11 §1 / §4）：
 * - available 只列已实现的能力；待实现的一律放 development，页面上标「开发中 / 试点」；
 * - 事实条目只陈述公开来源的内容，不暗示 Aster 已处理过这些案例；
 * - 卖点是「合规 / 政策人员能读、能审、能签字」，不是「业务人员自己写规则」；多语言最多作为次要说明。
 */
import type { SolutionSlug } from '@/lib/solutions';

export interface SolutionFact {
  id: string;
  href: string;
}

export interface SolutionContent {
  /** i18n 键：solutionsPage.pages.<messageKey> */
  messageKey: string;
  facts: SolutionFact[];
  available: string[];
  development: string[];
  /** 是否显示定位说明块（智能体护栏页：与 Cedar 运行时的关系）。 */
  positioning?: boolean;
  /** 可选的站内演示入口（已有的公开 demo 页）。 */
  demoHref?: string;
}

export const SOLUTION_CONTENT: Record<SolutionSlug, SolutionContent> = {
  'insurance-rating': {
    messageKey: 'insuranceRating',
    facts: [
      { id: 'filings', href: 'https://insurance-research.org/news/irc-study-shows-disparities-rate-regulation-personal-auto-insurance-has-negative-market' },
      { id: 'refund', href: 'https://www.tdi.texas.gov/commissioner/disciplinary-orders/documents/20259142.pdf' },
      { id: 'factorTable', href: 'https://www.tdi.texas.gov/commissioner/disciplinary-orders/documents/20259237.pdf' },
      { id: 'regulation57', href: 'https://www.dfs.ny.gov/system/files/documents/2024/03/da20240320.pdf' },
    ],
    available: ['readable', 'sealed', 'approval', 'evidence', 'template'],
    development: ['filingMap', 'impactQuery', 'documentView', 'scale'],
  },
  'credit-decisions': {
    messageKey: 'creditDecisions',
    facts: [
      { id: 'regB', href: 'https://www.ecfr.gov/current/title-12/chapter-X/part-1002/section-1002.9' },
      { id: 'supervision', href: 'https://business.cch.com/BFLD/CFPB-Supervisory-Highlights-Advanced-Technologies-Special-Edition-Issue-38-Winter-2025-01172025.pdf' },
      { id: 'settlement', href: 'https://www.mass.gov/news/ag-campbell-announces-25-million-settlement-with-student-loan-lender-for-unlawful-practices-through-ai-use-other-consumer-protection-violations' },
    ],
    available: ['readable', 'sealed', 'approval', 'trace', 'evidence', 'demo'],
    development: ['reasonCodes', 'impactQuery', 'documentView'],
    demoHref: '/demos/credit',
  },
  'agent-guardrails': {
    messageKey: 'agentGuardrails',
    facts: [
      { id: 'gsa', href: 'https://www.meritalk.com/articles/gsas-new-ai-contract-safeguards-take-effect/' },
      { id: 'agentcore', href: 'https://aws.amazon.com/blogs/security/why-policy-in-amazon-bedrock-agentcore-chose-cedar-for-securing-agentic-workflows/' },
    ],
    available: ['decisions', 'inbox', 'evidence', 'cedar'],
    development: ['adapters', 'latency', 'auditView', 'agentcore'],
    positioning: true,
  },
  'eligibility-rules': {
    messageKey: 'eligibilityRules',
    facts: [
      { id: 'louisiana', href: 'https://digitalgovernmenthub.org/wp-content/uploads/2026/01/RFI_HHS_Eligiblity_Systems-Final-OTS_9.29.25.pdf' },
      { id: 'clauseLogic', href: 'https://govtribe.com/file/government-file/general-cls-model-concept-oct-2024-dot-pdf' },
    ],
    available: ['readable', 'sealed', 'approval', 'trace', 'evidence', 'languages'],
    development: ['pointInTime', 'documentView', 'deployment'],
  },
};
