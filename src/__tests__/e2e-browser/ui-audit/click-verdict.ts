/**
 * UI 审计（#774）按钮探测的判定：一次点击之后观察到的效果 → 「有效 / 死按钮 / 无法确认」。
 *
 * 关键点：探测期间 API 请求（读与写）都会被拦截（request-guard.ts）。被拦的请求本身不能算按钮「有效」——
 * 请求根本没到服务器，之后的 DOM 变化也只是页面对伪造 503 的反应。所以：
 * - 点击后、第一个被拦请求之前就发生的 DOM 变化（打开面板、切换状态），算有效；
 * - 唯一的效果是被拦的 API 请求（及其后的 DOM 变化）时，判为「无法确认」，单独报出，不当作有效。
 *   被拦的写请求另外参与「破坏性操作无确认」判定（interactions.ts），与这里的有效性判定无关。
 */
export interface ClickEffects {
  /** 已处于选中态的切换按钮（再点本就不该有变化） */
  active: boolean;
  urlChanged: boolean;
  popup: boolean;
  downloaded: boolean;
  printed: boolean;
  nativeDialog: boolean;
  invalidForm: boolean;
  /** 放行到服务器的 fetch / xhr / 文档请求数 */
  allowedRequests: number;
  /** 被拦截的 API 请求路径（读与写） */
  blocked: string[];
  /** 第一个被拦请求之前的 DOM 变化数（无被拦请求时等于总数） */
  mutationsBeforeBlock: number;
  mutationsTotal: number;
}

export type ClickVerdict = 'ok' | 'dead' | 'unverified';

export function judgeClick(e: ClickEffects): ClickVerdict {
  if (e.active) return 'ok';
  const strong = e.urlChanged || e.popup || e.downloaded || e.printed || e.nativeDialog || e.invalidForm
    || e.allowedRequests > 0;
  if (strong || e.mutationsBeforeBlock > 0) return 'ok';
  if (e.blocked.length > 0) return 'unverified';
  return e.mutationsTotal > 0 ? 'ok' : 'dead';
}
