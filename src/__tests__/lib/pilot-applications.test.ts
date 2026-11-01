import { describe, expect, it } from 'vitest';
import { parsePilotApplication, pilotApplicationsToCsv } from '@/lib/pilot-applications';
import { isFreeMailDomain } from '@/lib/free-mail-domains';

const valid = {
  email: '  Jane.Doe@Insurer.Example ',
  company: ' Example Mutual ',
  role: 'actuarial_pricing',
  useCases: ['insurance_rating', 'other', 'insurance_rating'],
  painPoint: '  Filing vs production drift  ',
  consent: true,
  page: 'insurance-rating',
  locale: 'en',
  attribution: { utmSource: 'linkedin', utmCampaign: 'a1', referrerHost: 'www.linkedin.com', utmMedium: 'x@y.z' },
};

describe('parsePilotApplication', () => {
  it('规范化合法提交：邮箱小写、域名单列、用例去重、可选字段 trim、归因按白名单过滤', () => {
    const r = parsePilotApplication(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      email: 'jane.doe@insurer.example',
      emailDomain: 'insurer.example',
      freeMailDomain: false,
      company: 'Example Mutual',
      role: 'actuarial_pricing',
      useCases: ['insurance_rating', 'other'],
      painPoint: 'Filing vs production drift',
      landingPage: 'insurance-rating',
      locale: 'en',
      utmSource: 'linkedin',
      utmMedium: null,
      utmCampaign: 'a1',
      utmTerm: null,
      utmContent: null,
      referrerHost: 'www.linkedin.com',
    });
  });

  it('个人邮箱标记 freeMailDomain，痛点留空存 null', () => {
    const r = parsePilotApplication({ ...valid, email: 'someone@gmail.com', painPoint: '   ' });
    expect(r.ok && r.value.freeMailDomain).toBe(true);
    expect(r.ok && r.value.painPoint).toBeNull();
  });

  it.each([
    ['email', { email: 'not-an-email' }],
    ['email', { email: 'x@mailinator.com' }],
    ['company', { company: '   ' }],
    ['company', { company: 'x'.repeat(201) }],
    ['role', { role: 'ceo-of-everything' }],
    ['useCases', { useCases: [] }],
    ['useCases', { useCases: ['insurance_rating', 'crypto'] }],
    ['painPoint', { painPoint: 'x'.repeat(2001) }],
    ['consent', { consent: false }],
    ['consent', { consent: 'true' }],
    ['page', { page: 'pricing' }],
    ['locale', { locale: 'fr' }],
  ])('非法 %s → 拒绝', (field, patch) => {
    const r = parsePilotApplication({ ...valid, ...patch });
    expect(r).toEqual({ ok: false, field });
  });

  it('非对象 → 拒绝', () => {
    expect(parsePilotApplication(null)).toEqual({ ok: false, field: 'body' });
  });
});

describe('isFreeMailDomain', () => {
  it('识别常见个人邮箱，企业域名为 false', () => {
    expect(isFreeMailDomain('GMAIL.com')).toBe(true);
    expect(isFreeMailDomain('qq.com')).toBe(true);
    expect(isFreeMailDomain('allianz.de')).toBe(false);
  });
});

describe('pilotApplicationsToCsv', () => {
  it('输出表头 + 按 RFC 4180 转义逗号、引号与换行', () => {
    const csv = pilotApplicationsToCsv([
      {
        id: 'a1', createdAt: new Date('2026-11-01T10:00:00Z'), email: 'j@corp.example', emailDomain: 'corp.example',
        freeMailDomain: false, company: 'Corp, "Inc"', role: 'credit_risk', useCases: ['credit_decisions', 'other'],
        painPoint: 'line1\nline2', consentAt: new Date('2026-11-01T10:00:00Z'), landingPage: 'credit-decisions',
        locale: 'de', utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null,
        referrerHost: null,
      },
    ]);
    const [header, ...rest] = csv.split('\r\n');
    expect(header).toBe(
      'createdAt,email,emailDomain,freeMailDomain,company,role,useCases,painPoint,landingPage,locale,utmSource,utmMedium,utmCampaign,utmTerm,utmContent,referrerHost,consentAt',
    );
    expect(rest.join('\r\n')).toBe(
      '2026-11-01T10:00:00.000Z,j@corp.example,corp.example,false,"Corp, ""Inc""",credit_risk,credit_decisions|other,"line1\nline2",credit-decisions,de,,,,,,,2026-11-01T10:00:00.000Z\r\n',
    );
  });

  const base = {
    id: 'a2', createdAt: new Date('2026-11-01T10:00:00Z'), email: 'j@corp.example', emailDomain: 'corp.example',
    freeMailDomain: false, company: 'Corp', role: 'other', useCases: ['other'], painPoint: null,
    consentAt: new Date('2026-11-01T10:00:00Z'), landingPage: 'credit-decisions', locale: 'en',
    utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null, referrerHost: null,
  } as Parameters<typeof pilotApplicationsToCsv>[0][number];

  it.each(['=', '+', '-', '@', '\t', '\r'])('以 %j 开头的单元格加单引号前缀，防表格公式注入', (lead) => {
    const csv = pilotApplicationsToCsv([{ ...base, company: `${lead}SUM(1,2)` }]);
    const row = csv.split('\r\n')[1];
    expect(row).toContain(`"'${lead}SUM(1,2)"`);
  });

  it('所有列都转义：邮箱、UTM、痛点', () => {
    const csv = pilotApplicationsToCsv([{
      ...base,
      email: '=HYPERLINK("http://x","y")@a.co',
      utmSource: '+cmd',
      painPoint: '-2+3',
    }]);
    const row = csv.split('\r\n')[1];
    expect(row).toContain(`"'=HYPERLINK(""http://x"",""y"")@a.co"`);
    expect(row).toContain(`'+cmd`);
    expect(row).toContain(`'-2+3`);
    expect(row).not.toMatch(/(^|,)[=+\-@]/);
  });

  it.each([' =1+1', '  +SUM(A1)', '\u00a0-1', '＝1+1', '＋1', '－1', '＠SUM(A1)'])(
    '前导空白或全角公式字符 %j 也加前缀',
    (value) => {
      const row = pilotApplicationsToCsv([{ ...base, company: value }]).split('\r\n')[1];
      expect(row.split(',')[4]).toBe(`'${value}`);
    },
  );

  it('普通取值不加前缀', () => {
    const row = pilotApplicationsToCsv([base]).split('\r\n')[1];
    expect(row.startsWith('2026-11-01T10:00:00.000Z,j@corp.example,')).toBe(true);
  });
});
