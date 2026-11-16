/**
 * UI 审计（#774）按钮探测期间的请求闸门：决定一个请求放行、按「读」拦截还是按「写」拦截。
 *
 * 不依赖「GET 无副作用」的假设：探测期间所有 API 请求（任何源的 /api/**，含 aster-api）一律拦截，
 * 只放行页面文档、RSC 与静态资源的读请求；已知会改状态的页面（登出）也拦截。
 * 被拦的请求照样计为「按钮有效果」（发起了网络请求），只是不会到达服务器。
 */
export type GuardDecision = 'allow' | 'block-read' | 'block-write';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SIDE_EFFECT_PAGES = /^\/(?:[a-z]{2}\/)?(?:logout|verify-email|reset-password|teams\/invite|renew\/[^/]+)(?:\/|$)/;

export function classifyRequest(method: string, url: string): GuardDecision {
  if (!SAFE_METHODS.has(method.toUpperCase())) return 'block-write';
  const { pathname } = new URL(url);
  if (pathname.startsWith('/api/') || SIDE_EFFECT_PAGES.test(pathname)) return 'block-read';
  return 'allow';
}
