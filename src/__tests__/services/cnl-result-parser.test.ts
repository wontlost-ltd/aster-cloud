// 防回归：Bug-4（Execute Policy UI Decision 显示错）的核心字段识别
//
// 历史 bug：UI 在 evaluate-source 路径用 Boolean(整个 result 对象) 判断 approved；
//          且 cnl-executor.parseApprovalFromResult 的 approvalFields 列表缺
//          isEligible/eligible，导致 EligibilityResult{isEligible:false} 落入
//          _type 分支被判 approved=true。
//
// 修复方向：approvalFields 必须包含 isEligible/eligible/allowed/isAllowed/...
//          覆盖常见 policy 决策字段，保持英中德三语对齐。

import { describe, it, expect } from 'vitest';
import { parseApprovalFromResult } from '@/services/policy/cnl-executor';

describe('parseApprovalFromResult — 决策字段识别', () => {
  describe('Bug-4 核心字段：isEligible / eligible', () => {
    it('isEligible: false → approved: false（loan eligibility）', () => {
      const r = parseApprovalFromResult({
        _type: 'EligibilityResult',
        isEligible: false,
        reason: 'Applicant is under minimum age requirement',
      });
      expect(r.approved).toBe(false);
      expect(r.message).toContain('under minimum');
    });

    it('isEligible: true → approved: true', () => {
      const r = parseApprovalFromResult({
        _type: 'EligibilityResult',
        isEligible: true,
        reason: 'Applicant meets minimum age requirement',
      });
      expect(r.approved).toBe(true);
    });

    it('eligible: false（不带 is 前缀）→ approved: false', () => {
      const r = parseApprovalFromResult({ eligible: false, reason: 'rejected' });
      expect(r.approved).toBe(false);
    });
  });

  describe('其他批准字段', () => {
    it('approved: true', () => {
      expect(parseApprovalFromResult({ approved: true }).approved).toBe(true);
    });

    it('isApproved: false', () => {
      expect(parseApprovalFromResult({ isApproved: false }).approved).toBe(false);
    });

    it('allowed: true', () => {
      expect(parseApprovalFromResult({ allowed: true, reason: 'ok' }).approved).toBe(true);
    });

    it('isAllowed: false', () => {
      expect(parseApprovalFromResult({ isAllowed: false }).approved).toBe(false);
    });

    it('isSuccess: true', () => {
      expect(parseApprovalFromResult({ isSuccess: true }).approved).toBe(true);
    });

    it('success: false', () => {
      expect(parseApprovalFromResult({ success: false }).approved).toBe(false);
    });

    it('中文 "批准": true', () => {
      expect(parseApprovalFromResult({ '批准': true }).approved).toBe(true);
    });

    it('德文 "genehmigt": false', () => {
      expect(parseApprovalFromResult({ genehmigt: false }).approved).toBe(false);
    });
  });

  describe('字段优先级', () => {
    it('approved 优先于 _type fallback', () => {
      const r = parseApprovalFromResult({
        _type: 'Result',
        approved: false,
      });
      expect(r.approved).toBe(false);
    });

    it('isEligible: false 不会被 _type fallback 覆盖（Bug-4 反例）', () => {
      // 历史 bug：含 _type 的对象直接 approved:true，忽略 isEligible
      const r = parseApprovalFromResult({
        _type: 'EligibilityResult',
        isEligible: false,
      });
      expect(r.approved).toBe(false);
    });
  });

  describe('Fallback 行为', () => {
    it('只有 _type 没有决策字段 → approved: true（兼容已有计算结果）', () => {
      expect(parseApprovalFromResult({ _type: 'CalcResult', value: 42 }).approved).toBe(true);
    });

    it('只有 value 字段 → approved: true（计算类）', () => {
      expect(parseApprovalFromResult({ result: 100, message: 'ok' }).approved).toBe(true);
    });

    it('null → approved: false', () => {
      expect(parseApprovalFromResult(null).approved).toBe(false);
    });

    it('undefined → approved: false', () => {
      expect(parseApprovalFromResult(undefined).approved).toBe(false);
    });
  });

  describe('字符串结果（非对象）', () => {
    // 合规硬安全：decision 模式裸字符串**绝不**经关键字判 approve（自然语言批准
    // 措辞无法被关键字法可靠识别，含前/后置否定与撤销）。含批准词根的裸文本 →
    // indeterminate（非 approve、非真实拒绝）。要批准须返回结构化决策对象。
    it('"approved" 裸字符串（decision）→ indeterminate（不 fail-open approve）', () => {
      const r = parseApprovalFromResult('approved by all rules');
      expect(r.approved).toBe(false);
      expect(r.indeterminate).toBe(true);
    });

    it('"approved" 裸字符串（value 模式）→ approved（计算输出路径）', () => {
      expect(parseApprovalFromResult('approved by all rules', 'value').approved).toBe(true);
    });

    it('"denied" 关键词（decision）→ deny（保留原因，非 indeterminate）', () => {
      const r = parseApprovalFromResult('denied: insufficient credit');
      expect(r.approved).toBe(false);
      expect(r.indeterminate).toBeFalsy();
    });
  });

  // 决策路径 vs 计算路径的 mode 语义（合规安全边界）。
  // 生产 bug：greet → "Hello, John Smith!" 被 decision 路径误判拒绝（塞进
  // deniedReasons+error，success:false）。修复=三值：明确批准/拒绝关键字照常，
  // 无关键字的裸文本在 decision 模式 → indeterminate（不伪造拒绝、不 fail-open）。
  describe('字符串 mode 语义（decision vs value）', () => {
    it('decision 模式：无决策关键字的纯文本 → indeterminate（非批准、非真实拒绝）', () => {
      const r = parseApprovalFromResult('Hello, John Smith!', 'decision');
      expect(r.approved).toBe(false);
      expect(r.indeterminate).toBe(true);
      expect(r.message).toBe('Hello, John Smith!');
    });

    it('value 模式：无决策关键字的纯文本 → approved（成功的计算输出）', () => {
      const r = parseApprovalFromResult('Hello, John Smith!', 'value');
      expect(r.approved).toBe(true);
      expect(r.indeterminate).toBeFalsy();
    });

    it('默认 mode 为 decision（安全优先）', () => {
      expect(parseApprovalFromResult('Hello, John Smith!').indeterminate).toBe(true);
    });

    // Codex 退回理由的回归锁：真实信贷/理赔决策返回的裸字符串拒绝/转人工，
    // **绝不能在 decision 模式被判 approved:true（fail-open）**。它们或命中关键字
    // 判 deny，或无关键字 → indeterminate（fail-closed allowed:false），两者都安全。
    it.each([
      'Declined — credit score below threshold',
      'Refer to manual underwriting',
      'Zur Einzelfallprüfung',
      'Declined — below deductible',
      'Refer to adjuster',
      '拒赔 — 低于免赔额',
      '转定损员',
    ])('decision 模式真实拒绝/转人工裸字符串绝不 fail-open approve：%s', (s) => {
      expect(parseApprovalFromResult(s, 'decision').approved).toBe(false);
    });

    // 真实拒绝裸字符串应命中 denialKeywords → 真正 deny（非 indeterminate），
    // 保住拒绝原因链（不利行动解释/审计需要）。
    it.each([
      'Declined — credit score below threshold',
      'Refer to adjuster',
      '拒赔 — 低于免赔额',
    ])('真实拒绝裸字符串命中 deny（非 indeterminate，保原因）：%s', (s) => {
      const r = parseApprovalFromResult(s, 'decision');
      expect(r.approved).toBe(false);
      expect(r.indeterminate).toBeFalsy();
    });

    // Codex 74/100 退回理由：approvalKeywords 裸 includes 子串匹配导致**负向短语
    // fail-open**（'not approved' 含 'approved'、'unacceptable' 含 'accept'）。
    // 这些在 decision 模式下绝不能 approved:true。
    it.each([
      'not approved',
      'application is not approved',
      'not accepted',
      'unacceptable risk',
    ])('负向短语绝不被子串误判 approve（fail-open 防护）：%s', (s) => {
      expect(parseApprovalFromResult(s, 'decision').approved).toBe(false);
    });

    // 否定批准式：含批准词根但语义是拒绝，绝不能 fail-open approve（中/英/德）。
    // 在硬安全模型下，这些既可能命中拒绝关键字，也可能落 indeterminate——两者都
    // 是 approved:false（绝不 approve）。
    it.each([
      'Disapproved — policy criteria not met',
      'Unapproved applicant',
      'not approved',
      '未批准 — 信用分不足',
      '不批准 — 风险过高',
      '未通过 — KYC 失败',
      '没有通过审核',
      'Nicht genehmigt — Bonität zu niedrig',
    ])('否定批准式绝不 fail-open approve：%s', (s) => {
      expect(parseApprovalFromResult(s, 'decision').approved).toBe(false);
    });

    // 合规硬安全：正向批准的**裸字符串**在 decision 模式也不 approve（自然语言
    // 批准措辞不可靠）→ indeterminate（allowed:false，fail-closed）。要批准须返回
    // 结构化决策对象（{ approved: true }）。后置否定（"Approved: no"）等尾巴随之
    // 自动消除——根本不存在「裸字符串 → approve」路径。
    it.each([
      'Approved — premium rate',
      '批准，优惠利率',
      'Genehmigt mit Vorzugszins',
      'Approved: no',          // 后置否定：旧启发式会 fail-open，现统一 indeterminate
      '批准：否',
      'previously approved, now revoked',
    ])('正向/歧义批准裸字符串（decision）→ 不 approve（须结构化决策）：%s', (s) => {
      expect(parseApprovalFromResult(s, 'decision').approved).toBe(false);
    });

    // 但结构化决策对象仍精确批准（这才是 decision 路径表达批准的正确方式）。
    it('结构化 { approved: true } → approved（decision 路径正道）', () => {
      expect(parseApprovalFromResult({ approved: true, reason: 'premium rate' }).approved).toBe(true);
    });
  });

  // 本地化布尔字面量：CNL 引擎执行后 Bool 字段保留本地化字符串（真/wahr），
  // 而非统一 JS boolean。此前真值判断只认 true/'true' → 中文/德文 Bool 被误判
  // false，「批准=真、信用良好」却落入 deniedReasons（用户反馈的违反直觉案例）。
  describe('本地化布尔值（zh 真/假 · de wahr/falsch）', () => {
    it('中文：批准="真" + 理由="信用良好" → approved: true（不进 deniedReasons）', () => {
      const r = parseApprovalFromResult({
        _type: '决定',
        批准: '真',
        利率: 450,
        理由: '信用良好',
      });
      expect(r.approved).toBe(true);
      expect(r.message).toBe('信用良好');
    });

    it('中文：批准="假" + 理由="信用评分过低" → approved: false', () => {
      const r = parseApprovalFromResult({
        _type: '决定',
        批准: '假',
        理由: '信用评分过低',
      });
      expect(r.approved).toBe(false);
      expect(r.message).toBe('信用评分过低');
    });

    it('德文：genehmigt="wahr" → approved: true', () => {
      const r = parseApprovalFromResult({
        _type: 'Entscheidung',
        genehmigt: 'wahr',
        begruendung: 'Gute Bonitaet',
      });
      expect(r.approved).toBe(true);
    });

    it('德文：genehmigt="falsch" → approved: false', () => {
      const r = parseApprovalFromResult({
        genehmigt: 'falsch',
        begruendung: 'Bonitaet zu niedrig',
      });
      expect(r.approved).toBe(false);
    });

    it('英文 boolean true/"true" 仍正确（无回归）', () => {
      expect(parseApprovalFromResult({ approved: true, reason: 'ok' }).approved).toBe(true);
      expect(parseApprovalFromResult({ approved: 'true', reason: 'ok' }).approved).toBe(true);
    });
  });
});

describe('Verdict 内置值（ADR 0039）', () => {
  it('ALLOW → approved', () => {
    expect(parseApprovalFromResult({ __type: 'Verdict', outcome: 'ALLOW' })).toEqual({ approved: true, outcome: 'ALLOW', message: 'Approved' });
  });
  it('DENY → denied，带 reason', () => {
    expect(parseApprovalFromResult({ __type: 'Verdict', outcome: 'DENY', reason: 'no consent' })).toEqual({ approved: false, outcome: 'DENY', message: 'no consent' });
  });
  it('REQUIRE_APPROVAL → 不批准、专属 outcome、非 indeterminate（ADR 0041 §4）', () => {
    const r = parseApprovalFromResult({ __type: 'Verdict', outcome: 'REQUIRE_APPROVAL', role: 'Senior Underwriter', reason: 'over cap' });
    expect(r).toEqual({ approved: false, outcome: 'REQUIRE_APPROVAL', message: 'over cap' });
  });
  it('ESCALATE → 不批准、专属 outcome、非 indeterminate（ADR 0041 §4）', () => {
    const r = parseApprovalFromResult({ __type: 'Verdict', outcome: 'ESCALATE', reason: 'low confidence' });
    expect(r).toEqual({ approved: false, outcome: 'ESCALATE', message: 'low confidence' });
  });
  it('未知 outcome → indeterminate 且不带 outcome', () => {
    const r = parseApprovalFromResult({ __type: 'Verdict', outcome: 'MAYBE' });
    expect(r.approved).toBe(false); expect(r.indeterminate).toBe(true); expect(r.outcome).toBeUndefined();
  });
  it('value 模式下同样按 outcome 解读', () => {
    expect(parseApprovalFromResult({ __type: 'Verdict', outcome: 'DENY', reason: 'x' }, 'value')).toEqual({ approved: false, outcome: 'DENY', message: 'x' });
  });
});
