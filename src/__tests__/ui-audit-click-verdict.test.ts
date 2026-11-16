/** UI 审计（#774）按钮判定：被拦截的 API 请求（读或写）不能让按钮算作「有效」。 */
import { describe, expect, it } from 'vitest';
import { type ClickEffects, judgeClick } from './e2e-browser/ui-audit/click-verdict';

const none: ClickEffects = {
  active: false, urlChanged: false, popup: false, downloaded: false, printed: false, nativeDialog: false,
  invalidForm: false, allowedRequests: 0, blocked: [], mutationsBeforeBlock: 0, mutationsTotal: 0,
};

describe('judgeClick', () => {
  it('flags a button with no effect at all as dead', () => {
    expect(judgeClick(none)).toBe('dead');
  });

  it('does not count a blocked API read (and the DOM reacting to the fake 503) as working', () => {
    expect(judgeClick({ ...none, blocked: ['GET /api/reports'], mutationsTotal: 4 })).toBe('unverified');
  });

  it('does not count a blocked write as working either', () => {
    expect(judgeClick({ ...none, blocked: ['POST /api/teams'], mutationsTotal: 2 })).toBe('unverified');
  });

  it('counts DOM changes that happened before the first blocked request', () => {
    expect(judgeClick({ ...none, blocked: ['GET /api/reports'], mutationsBeforeBlock: 2, mutationsTotal: 6 })).toBe('ok');
  });

  it('counts navigation, dialogs, downloads, printing, allowed requests and form validation', () => {
    for (const k of ['urlChanged', 'popup', 'downloaded', 'printed', 'nativeDialog', 'invalidForm'] as const) {
      expect(judgeClick({ ...none, [k]: true })).toBe('ok');
    }
    expect(judgeClick({ ...none, allowedRequests: 1 })).toBe('ok');
  });

  it('counts plain DOM changes when nothing was blocked', () => {
    expect(judgeClick({ ...none, mutationsBeforeBlock: 3, mutationsTotal: 3 })).toBe('ok');
  });

  it('skips toggles that are already active', () => {
    expect(judgeClick({ ...none, active: true })).toBe('ok');
  });
});
