/**
 * AI 流内 provider 错误码 → 展示视图（纯函数，唯一映射点）。
 *
 * 背景：aster-api 的 SSE error 帧携带机器可读码（provider_auth_failed 等）与脱敏后的 provider 原话。
 * 此前前端把码字符串直接显示给用户（「provider_rejected_model」），provider 真正的解释
 * （如 Anthropic key 未绑定 workspace）永远到不了用户。
 *
 * 本模块只决定「用哪条 i18n 文案、是否附 provider 原话、是否给设置页入口」，不碰 React/i18n 实例，
 * 便于单测；文案本身在 `ai.*`（src/i18n/demo-supplement.ts）。
 *
 * 向后兼容：旧版 aster-api 把任意 400 标成 provider_rejected_model 且没有 message，
 * 所以该码的文案用「未接受该请求（模型名或 key 权限）」这种不武断的措辞。
 */

/** 前端能给出专门文案的 provider 错误码。 */
export type ProviderErrorCode =
  | 'provider_auth_failed'
  | 'provider_rejected_model'
  | 'provider_bad_request'
  | 'provider_rate_limited'
  | 'provider_unavailable';

/** useSSEStream 暴露的结构化流内错误。 */
export interface StreamErrorDetail {
  code: string;
  /** 最近一次 meta 帧回传的实际发出的 model；无则 null。 */
  model: string | null;
  /** aster-api 已脱敏的 provider 原话；旧版 aster-api 为 null。 */
  providerMessage: string | null;
}

/** `ai` 命名空间下与 provider 错误相关的全部 key（测试据此核对四语言齐全）。 */
export const PROVIDER_ERROR_MESSAGE_KEYS = [
  'errorProviderAuthFailed',
  'errorProviderRejectedModel',
  'errorProviderRejectedModelUnknown',
  'errorProviderBadRequest',
  'errorProviderRateLimited',
  'errorProviderUnavailable',
  'goAiKeys',
] as const;

export type ProviderErrorMessageKey = (typeof PROVIDER_ERROR_MESSAGE_KEYS)[number];

export interface ProviderErrorView {
  messageKey: ProviderErrorMessageKey;
  /** ICU 占位符取值（仅 rejected_model 需要 model）。 */
  values: { model: string } | undefined;
  /** 作为第二行展示的 provider 原话；无则 null。 */
  providerMessage: string | null;
  /** 是否给「去 设置 → AI 密钥」入口：key / 模型问题用户可自行修正。 */
  showAiKeysLink: boolean;
}

/** 认识的码 → 视图；不认识（含 undefined）返回 null，调用方回落到原有展示。 */
export function providerErrorView(detail: StreamErrorDetail | null): ProviderErrorView | null {
  if (!detail) return null;
  const providerMessage = detail.providerMessage?.trim() || null;
  switch (detail.code as ProviderErrorCode) {
    case 'provider_auth_failed':
      return { messageKey: 'errorProviderAuthFailed', values: undefined, providerMessage, showAiKeysLink: true };
    case 'provider_rejected_model':
      return detail.model
        ? { messageKey: 'errorProviderRejectedModel', values: { model: detail.model }, providerMessage, showAiKeysLink: true }
        : { messageKey: 'errorProviderRejectedModelUnknown', values: undefined, providerMessage, showAiKeysLink: true };
    case 'provider_bad_request':
      return { messageKey: 'errorProviderBadRequest', values: undefined, providerMessage, showAiKeysLink: true };
    case 'provider_rate_limited':
      return { messageKey: 'errorProviderRateLimited', values: undefined, providerMessage, showAiKeysLink: false };
    case 'provider_unavailable':
      return { messageKey: 'errorProviderUnavailable', values: undefined, providerMessage, showAiKeysLink: false };
    default:
      return null;
  }
}
