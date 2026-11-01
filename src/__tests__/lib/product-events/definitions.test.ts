import { describe, expect, it } from 'vitest';
import {
  CLIENT_PRODUCT_EVENTS,
  isProductEventName,
  readAttribution,
  sanitizeEventProperties,
} from '@/lib/product-events/definitions';

describe('product-events 定义与属性白名单', () => {
  it('只认声明过的事件名', () => {
    expect(isProductEventName('template_selected')).toBe(true);
    expect(isProductEventName('signup_completed')).toBe(true);
    expect(isProductEventName('policy_content_dump')).toBe(false);
    expect(isProductEventName(42)).toBe(false);
  });

  it('客户端只能上报浏览器侧事件，服务端事件不在客户端白名单', () => {
    expect(CLIENT_PRODUCT_EVENTS).toContain('landing_viewed');
    expect(CLIENT_PRODUCT_EVENTS).toContain('template_selected');
    expect(CLIENT_PRODUCT_EVENTS).toContain('approvals_inbox_viewed');
    expect(CLIENT_PRODUCT_EVENTS).not.toContain('signup_completed');
    expect(CLIENT_PRODUCT_EVENTS).not.toContain('policy_first_executed');
  });

  it('丢弃未声明的键（策略内容、输入、邮箱都进不来）', () => {
    const out = sanitizeEventProperties('template_selected', {
      templateId: 'loan-evaluation',
      source: 'picker',
      content: 'Module finance.loan. Rule ...',
      input: { income: 1 },
      email: 'someone@example.com',
    });
    expect(out).toEqual({ templateId: 'loan-evaluation', source: 'picker' });
  });

  it('丢弃形状不合法的取值', () => {
    expect(sanitizeEventProperties('template_selected', { templateId: 'has space', source: 'nope' })).toEqual({});
    expect(sanitizeEventProperties('template_selected', { templateId: 'x'.repeat(65) })).toEqual({});
    expect(sanitizeEventProperties('evidence_exported', { format: 'json', scope: 'policy', verifiableOnly: 'yes' }))
      .toEqual({ format: 'json', scope: 'policy' });
  });

  it('UTM 拒绝像邮箱的值与超长值，保留常规取值', () => {
    expect(
      sanitizeEventProperties('landing_viewed', {
        page: 'insurance-rating',
        locale: 'en',
        utmSource: 'linkedin',
        utmCampaign: 'jane@corp.com',
        utmMedium: 'x'.repeat(101),
        referrerHost: 'www.linkedin.com',
      }),
    ).toEqual({ page: 'insurance-rating', locale: 'en', utmSource: 'linkedin', referrerHost: 'www.linkedin.com' });
  });

  it('落地页 page 只接受已登记的 slug，locale 只接受站点语种', () => {
    expect(sanitizeEventProperties('landing_viewed', { page: 'pricing', locale: 'fr' })).toEqual({});
  });

  it('非对象输入返回空对象', () => {
    expect(sanitizeEventProperties('landing_viewed', null)).toEqual({});
    expect(sanitizeEventProperties('landing_viewed', ['a'])).toEqual({});
  });
});

describe('readAttribution', () => {
  it('读取 utm_* 与外站 referrer 主机名（不保留路径与查询串）', () => {
    const attr = readAttribution(
      'https://aster-lang.cloud/solutions/insurance-rating?utm_source=linkedin&utm_medium=social&utm_campaign=a1&utm_term=rate&utm_content=v2',
      'https://www.linkedin.com/feed/update/123?trk=abc',
    );
    expect(attr).toEqual({
      utmSource: 'linkedin',
      utmMedium: 'social',
      utmCampaign: 'a1',
      utmTerm: 'rate',
      utmContent: 'v2',
      referrerHost: 'www.linkedin.com',
    });
  });

  it('站内 referrer 不算来源，缺省字段省略', () => {
    expect(readAttribution('https://aster-lang.cloud/solutions/credit-decisions', 'https://aster-lang.cloud/')).toEqual({});
  });

  it('referrer 非法时忽略', () => {
    expect(readAttribution('https://aster-lang.cloud/x?utm_source=hn', 'not a url')).toEqual({ utmSource: 'hn' });
  });
});
