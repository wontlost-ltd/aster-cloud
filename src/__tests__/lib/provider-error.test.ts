// provider 错误码 → 展示视图的纯映射 + 四语言文案齐全性。
import { describe, it, expect } from 'vitest';
import { providerErrorView, PROVIDER_ERROR_MESSAGE_KEYS } from '@/lib/provider-error';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';

const d = (code: string, model: string | null = null, providerMessage: string | null = null) => ({ code, model, providerMessage });

describe('providerErrorView', () => {
  it('provider_auth_failed → 鉴权文案 + 设置入口 + provider 原话', () => {
    expect(providerErrorView(d('provider_auth_failed', 'm', 'bad key'))).toEqual({
      messageKey: 'errorProviderAuthFailed', values: undefined, providerMessage: 'bad key', showAiKeysLink: true,
    });
  });

  it('provider_rejected_model：带 model 取占位文案，缺 model 取无模型变体', () => {
    expect(providerErrorView(d('provider_rejected_model', 'claude-x'))).toMatchObject({
      messageKey: 'errorProviderRejectedModel', values: { model: 'claude-x' }, showAiKeysLink: true,
    });
    expect(providerErrorView(d('provider_rejected_model'))).toMatchObject({
      messageKey: 'errorProviderRejectedModelUnknown', values: undefined,
    });
  });

  it('★事故 fixture：provider_bad_request 展示 workspace 说明作为次要行', () => {
    const msg = 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.';
    expect(providerErrorView(d('provider_bad_request', 'claude-x', msg))).toMatchObject({
      messageKey: 'errorProviderBadRequest', providerMessage: msg, showAiKeysLink: true,
    });
  });

  it('限流 / 不可用：不给设置入口', () => {
    expect(providerErrorView(d('provider_rate_limited'))).toMatchObject({ messageKey: 'errorProviderRateLimited', showAiKeysLink: false });
    expect(providerErrorView(d('provider_unavailable'))).toMatchObject({ messageKey: 'errorProviderUnavailable', showAiKeysLink: false });
  });

  it('空白 providerMessage 视为无；未知码 / null → null（回落原有展示）', () => {
    expect(providerErrorView(d('provider_bad_request', null, '   '))?.providerMessage).toBeNull();
    expect(providerErrorView(d('out_of_scope'))).toBeNull();
    expect(providerErrorView(null)).toBeNull();
  });
});

describe('文案 key 四语言齐全', () => {
  for (const locale of ['en', 'zh', 'de', 'hi'] as const) {
    it(`${locale}: ai.* provider 错误 key 全部非空，rejected_model 含 {model}`, () => {
      const ai = DEMO_SUPPLEMENT[locale].ai as Record<string, string>;
      for (const k of PROVIDER_ERROR_MESSAGE_KEYS) expect(ai[k], `${locale}.ai.${k}`).toBeTruthy();
      expect(ai.errorProviderRejectedModel).toContain('{model}');
      const page = (DEMO_SUPPLEMENT[locale].settings as { aiKeysPage: Record<string, string> }).aiKeysPage;
      expect(page.keyRejected, `${locale}.settings.aiKeysPage.keyRejected`).toBeTruthy();
    });
  }

  it('hi 为天城文', () => {
    const ai = DEMO_SUPPLEMENT.hi.ai as Record<string, string>;
    for (const k of PROVIDER_ERROR_MESSAGE_KEYS) expect(ai[k]).toMatch(/[ऀ-ॿ]/);
  });
});
