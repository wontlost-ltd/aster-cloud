/**
 * UI 审计（#774）的页面内检查：以纯函数形式在浏览器里执行（page.evaluate），只读 DOM 与计算样式，不改页面。
 *
 * 每个函数自成一体（不能引用模块内其他符号，Playwright 会把函数源码序列化后注入页面）。
 */

/** 移动端点击目标下限（CSS px）：项目规范 44×44（WCAG 2.5.5 AAA / Apple HIG），#774 设计决策 4 */
export const MOBILE_MIN_TARGET = 44;

export interface Offender {
  selector: string;
  text: string;
  box: { x: number; y: number; w: number; h: number };
}

export interface LayoutReport {
  scrollWidth: number;
  clientWidth: number;
  overflowOffenders: Offender[];
  smallTargets: Array<Offender & { min: number }>;
  cardIssues: Array<{ kind: 'height' | 'padding' | 'overlap' | 'overflow'; grid: string; detail: string }>;
  dataTheme: string | null;
}

/** 水平溢出、移动端点击目标、卡片网格一致性。 */
export function collectLayout(opts: { mobile: boolean; minTarget: number }): LayoutReport {
  const vw = document.documentElement.clientWidth;
  const sel = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let i = 0; cur && i < 4; i += 1) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`${s}#${cur.id}`);
        break;
      }
      const cls = (cur.getAttribute('class') || '').split(/\s+/).filter((c) => c && !c.includes(':')).slice(0, 3);
      if (cls.length) s += `.${cls.join('.')}`;
      parts.unshift(s);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const boxOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const textOf = (el: Element) =>
    ((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0 && !el.closest('[aria-hidden="true"], [inert]');
  };
  // 在可横向滚动 / 裁剪容器内的元素不会撑开页面
  const insideScroller = (el: Element) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
    }
    return false;
  };

  // 1. 水平溢出：逐个隐藏越界元素，能让文档变窄的才是根因；固定定位元素随视口变宽只是症状，不参与。
  //    （例如 sr-only 表头在非定位滚动容器里绝对定位，会逃出 overflow-x-auto 撑宽整页）
  const overflowOffenders: Offender[] = [];
  const scrollWidth = document.documentElement.scrollWidth;
  if (scrollWidth > vw + 1) {
    const causes: Element[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      if (causes.length >= 40) break;
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky' || el.getBoundingClientRect().right <= vw + 1) continue;
      const prev = el.style.display;
      el.style.display = 'none';
      const narrower = document.documentElement.scrollWidth < scrollWidth;
      el.style.display = prev;
      if (narrower) causes.push(el);
    }
    // 只报最深的那层（其后代里没有别的根因）
    for (const el of causes.filter((c) => !causes.some((d) => d !== c && c.contains(d))).slice(0, 8)) {
      overflowOffenders.push({ selector: sel(el), text: textOf(el), box: boxOf(el) });
    }
  }

  // 2. 移动端点击目标：项目规范 ≥44×44 CSS px（WCAG 2.5.5 AAA）；句中行内链接按 WCAG 例外豁免
  const smallTargets: LayoutReport['smallTargets'] = [];
  if (opts.mobile) {
    const q = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], [role=menuitem]';
    for (const el of Array.from(document.querySelectorAll(q))) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      if (el.tagName === 'A' && cs.display === 'inline') {
        const parentText = (el.parentElement?.textContent || '').trim();
        if (parentText.length > (el.textContent || '').trim().length + 3) continue;
      }
      // 原生复选框 / 单选框常由外层 label 扩大点击区
      if (el.tagName === 'INPUT' && el.closest('label')) continue;
      const r = el.getBoundingClientRect();
      // sr-only 元素（如跳到主内容链接）平时被裁成 1px，聚焦时才展开，不算点击目标
      if (r.width <= 1 || r.height <= 1) continue;
      const min = Math.round(Math.min(r.width, r.height));
      if (min < opts.minTarget) smallTargets.push({ selector: sel(el), text: textOf(el), box: boxOf(el), min });
    }
  }

  // 3. 卡片网格：同一行卡片等高、内边距一致、互不重叠、内容不越出卡片
  const cardIssues: LayoutReport['cardIssues'] = [];
  const cardLike = (el: Element | null): el is HTMLElement => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    const bordered = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
    const shadowed = cs.boxShadow && cs.boxShadow !== 'none';
    return (bordered || !!shadowed) && parseFloat(cs.borderTopLeftRadius) > 0;
  };
  for (const grid of Array.from(document.querySelectorAll('*'))) {
    const cs = getComputedStyle(grid);
    if (cs.display !== 'grid' && cs.display !== 'inline-grid') continue;
    const cells = Array.from(grid.children).filter(visible);
    if (cells.length < 2) continue;
    const cards = cells
      .map((c) => (cardLike(c) ? c : c.children.length === 1 && cardLike(c.firstElementChild) ? (c.firstElementChild as HTMLElement) : null))
      .filter((c): c is HTMLElement => c !== null);
    if (cards.length < 2 || cards.length < cells.length * 0.75) continue;
    const gname = sel(grid);
    const rows = new Map<number, HTMLElement[]>();
    // 按所在网格单元的顶边分行（卡片可能包在单元内的链接里）
    for (const c of cards) {
      const cell = cells.find((x) => x === c || x.contains(c)) as Element;
      const key = Math.round(cell.getBoundingClientRect().top);
      rows.set(key, [...(rows.get(key) || []), c]);
    }
    for (const [, row] of rows) {
      if (row.length < 2) continue;
      const hs = row.map((c) => Math.round(c.getBoundingClientRect().height));
      if (Math.max(...hs) - Math.min(...hs) > 2) {
        cardIssues.push({ kind: 'height', grid: gname, detail: `same-row card heights ${hs.join('/')}px` });
      }
    }
    const pads = new Set(cards.map((c) => getComputedStyle(c).padding));
    if (pads.size > 1) cardIssues.push({ kind: 'padding', grid: gname, detail: `paddings ${Array.from(pads).join(' | ')}` });
    for (let i = 0; i < cards.length; i += 1) {
      const a = cards[i].getBoundingClientRect();
      for (let j = i + 1; j < cards.length; j += 1) {
        const b = cards[j].getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2) cardIssues.push({ kind: 'overlap', grid: gname, detail: `cards #${i} and #${j} overlap ${Math.round(w)}×${Math.round(h)}px` });
      }
      for (const d of Array.from(cards[i].querySelectorAll('*'))) {
        if (!visible(d) || insideScroller(d)) continue;
        const r = d.getBoundingClientRect();
        if (r.right > a.right + 1 || r.left < a.left - 1) {
          cardIssues.push({ kind: 'overflow', grid: gname, detail: `card #${i} child ${sel(d)} "${textOf(d)}" exceeds card edge` });
          break;
        }
      }
    }
  }

  return {
    scrollWidth,
    clientWidth: vw,
    overflowOffenders,
    smallTargets,
    cardIssues: cardIssues.slice(0, 20),
    dataTheme: document.documentElement.getAttribute('data-theme'),
  };
}

export interface LinkInfo {
  href: string | null;
  resolved: string;
  text: string;
  target: string | null;
  rel: string | null;
  inShell: boolean;
  hashTargetMissing: boolean;
}

/** 收集页面上全部 <a>（含不可见的，如折叠菜单里的链接），带外壳标记与页内锚点存在性。 */
export function collectLinks(): LinkInfo[] {
  return Array.from(document.querySelectorAll('a')).map((a) => {
    const href = a.getAttribute('href');
    let hashTargetMissing = false;
    if (href && href.startsWith('#') && href.length > 1) {
      const id = decodeURIComponent(href.slice(1));
      hashTargetMissing = !document.getElementById(id) && !document.getElementsByName(id).length;
    }
    return {
      href,
      resolved: a.href,
      text: ((a as HTMLElement).innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel'),
      inShell: !!a.closest('header, footer, aside, nav, [role=dialog]'),
      hashTargetMissing,
    };
  });
}

export interface FocusReport {
  checked: number;
  invisible: Array<{ selector: string; text: string }>;
}

/** 当前聚焦元素是否有可见焦点指示（outline / box-shadow ring / 边框或背景变化）。在 Tab 之后调用。 */
export function focusIndicator(): { ok: boolean; selector: string; text: string } | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const ring = cs.boxShadow !== 'none' && cs.boxShadow !== '';
  const deco = cs.textDecorationLine.includes('underline');
  // 焦点环画在外层包装上（focus-within，如带前缀的输入框）也算：只认 outline 或「0 0 0 Npx」形式的环，
  // 普通投影（卡片的 shadow-sm）不算
  let wrapperRing = false;
  for (let p = el.parentElement, i = 0; p && i < 2 && !wrapperRing; p = p.parentElement, i += 1) {
    if (!p.matches(':focus-within')) break;
    const pcs = getComputedStyle(p);
    wrapperRing = (pcs.outlineStyle !== 'none' && parseFloat(pcs.outlineWidth) > 0)
      || /0px 0px 0px [1-9]/.test(pcs.boxShadow);
  }
  const id = el.id ? `#${el.id}` : '';
  const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
  return { ok: outline || ring || deco || wrapperRing, selector: `${el.tagName.toLowerCase()}${id}`, text };
}
