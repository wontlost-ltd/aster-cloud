/**
 * 产品分析事件的定义与属性白名单（纯函数，浏览器与服务端共用）。
 *
 * 数据最小化在这里强制：每个事件只允许声明过的属性键，且取值必须通过对应的形状校验；
 * 其余一律丢弃。因此策略源码、执行输入、邮箱、姓名即使被误传也进不了事件表。
 */
import { locales } from '@/i18n/config';
import { SOLUTION_SLUGS } from '@/lib/solutions';

type PropertySpec =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'slug' }
  | { kind: 'bool' }
  | { kind: 'utm' }
  | { kind: 'host' };

const UTM: PropertySpec = { kind: 'utm' };
const HOST: PropertySpec = { kind: 'host' };
const PAGE: PropertySpec = { kind: 'enum', values: SOLUTION_SLUGS };
const LOCALE: PropertySpec = { kind: 'enum', values: locales };

/** 来源归因属性（落地页访问与表单提交共用）。 */
const ATTRIBUTION = {
  utmSource: UTM,
  utmMedium: UTM,
  utmCampaign: UTM,
  utmTerm: UTM,
  utmContent: UTM,
  referrerHost: HOST,
} as const;

/**
 * 事件清单。`once: true` 表示每个用户只记一次（首次保存 / 首次执行）；
 * `client: true` 表示允许浏览器经 /api/product-events 上报。
 *
 * Guard API 调用不在此表：aster-api 已把每次 guard 判定按租户计入 ApiCallRecord
 * （endpointPath=/api/v1/guard/decisions），汇总时直接读那张表，不重复落一份。
 */
export const PRODUCT_EVENT_DEFINITIONS = {
  signup_completed: { props: {} },
  template_selected: {
    client: true,
    props: {
      templateId: { kind: 'slug' },
      source: { kind: 'enum', values: ['picker', 'palette', 'deeplink'] },
    },
  },
  policy_first_saved: { once: true, props: {} },
  policy_first_executed: {
    once: true,
    props: { source: { kind: 'enum', values: ['dashboard', 'api'] } },
  },
  evidence_exported: {
    props: {
      format: { kind: 'enum', values: ['json', 'jsonl'] },
      scope: { kind: 'enum', values: ['policy', 'all'] },
      verifiableOnly: { kind: 'bool' },
    },
  },
  approvals_inbox_viewed: { client: true, props: {} },
  landing_viewed: {
    client: true,
    props: { page: PAGE, locale: LOCALE, ...ATTRIBUTION },
  },
  pilot_application_submitted: {
    props: { page: PAGE, locale: LOCALE, freeMailDomain: { kind: 'bool' }, ...ATTRIBUTION },
  },
} as const satisfies Record<string, { props: Record<string, PropertySpec>; once?: boolean; client?: boolean }>;

export type ProductEventName = keyof typeof PRODUCT_EVENT_DEFINITIONS;
export type ProductEventProperties = Record<string, string | boolean>;

/** 由 aster-api 用量记录派生的虚拟事件名（只出现在汇总报表里）。 */
export const GUARD_API_EVENT = 'guard_api_called';

export const PRODUCT_EVENT_NAMES = Object.keys(PRODUCT_EVENT_DEFINITIONS) as ProductEventName[];

export const CLIENT_PRODUCT_EVENTS = PRODUCT_EVENT_NAMES.filter(
  (name) => (PRODUCT_EVENT_DEFINITIONS[name] as { client?: boolean }).client === true,
);

export function isProductEventName(value: unknown): value is ProductEventName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PRODUCT_EVENT_DEFINITIONS, value);
}

export function isOncePerActor(name: ProductEventName): boolean {
  return (PRODUCT_EVENT_DEFINITIONS[name] as { once?: boolean }).once === true;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// UTM 只放行常见的营销标记字符；`@` 不在集合内，挡住把邮箱塞进 utm_* 的情况。
const UTM_RE = /^[\p{L}\p{N} _.+\-/:|]{1,100}$/u;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/i;

function acceptValue(spec: PropertySpec, value: unknown): string | boolean | undefined {
  switch (spec.kind) {
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? value : undefined;
    case 'slug':
      return typeof value === 'string' && SLUG_RE.test(value) ? value : undefined;
    case 'utm':
      return typeof value === 'string' && UTM_RE.test(value.trim()) ? value.trim() : undefined;
    case 'host':
      return typeof value === 'string' && HOST_RE.test(value) ? value.toLowerCase() : undefined;
  }
}

/** 按事件白名单过滤属性：未声明的键与形状不对的取值都被丢弃。 */
export function sanitizeEventProperties(name: ProductEventName, raw: unknown): ProductEventProperties {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const specs = PRODUCT_EVENT_DEFINITIONS[name].props as Record<string, PropertySpec>;
  const out: ProductEventProperties = {};
  for (const [key, spec] of Object.entries(specs)) {
    const accepted = acceptValue(spec, (raw as Record<string, unknown>)[key]);
    if (accepted !== undefined) out[key] = accepted;
  }
  return out;
}

const UTM_PARAMS = {
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  utm_term: 'utmTerm',
  utm_content: 'utmContent',
} as const;

export type Attribution = Partial<Record<(typeof UTM_PARAMS)[keyof typeof UTM_PARAMS] | 'referrerHost', string>>;

/**
 * 从当前页面 URL 与 document.referrer 取来源归因：utm_* 原值 + 外站 referrer 的主机名。
 * 只取主机名，referrer 的路径与查询串可能含个人信息，一律不留。站内跳转不算来源。
 */
export function readAttribution(pageUrl: string, referrer: string | null | undefined): Attribution {
  const out: Attribution = {};
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return out;
  }
  for (const [param, key] of Object.entries(UTM_PARAMS)) {
    const value = page.searchParams.get(param);
    if (value) out[key] = value;
  }
  if (referrer) {
    try {
      const host = new URL(referrer).hostname;
      if (host && host !== page.hostname) out.referrerHost = host;
    } catch {
      // 非法 referrer 直接忽略
    }
  }
  return out;
}
