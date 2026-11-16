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
    // 收起的 <details> 里的内容（Chrome 以 content-visibility 隐藏，盒子尺寸仍在）、祖先透明度为 0 或不可见的，都不可见也不可点
    if ('checkVisibility' in el && !(el as HTMLElement).checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false;
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
    const q = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option]';
    // 禁用的控件无法操作：既不算点击目标，也不参与相邻目标的重叠判定
    const targets = Array.from(document.querySelectorAll(q)).filter((el) => visible(el)
      && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true');
    // 对点击区中心那块 minTarget × minTarget 的方块（区域更小时取整块区域）做 5×5 网格命中测试：
    // 每个测点都要命中本元素（或其后代）。只要求这块方块，而不是整个伪元素——宽按钮的伪元素两端被相邻目标盖住不影响
    // 「存在一块 44×44 可点区域」。测完恢复滚动位置。
    const hitsCentralSquare = (el: Element, area: (q: DOMRect) => { left: number; right: number; top: number; bottom: number }) => {
      // 记下页面与所有可滚动祖先的滚动位置，测完恢复（审计不改变页面状态）
      const scrollers: Array<[Element, number, number]> = [];
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth) scrollers.push([p, p.scrollLeft, p.scrollTop]);
      }
      const sx = window.scrollX;
      const sy = window.scrollY;
      // 依次把元素滚到视口（及其滚动容器）中部、再滚到「刚好可见」处测：列表在滚动容器里、或固定浮层（右下角助手按钮等）
      // 只在某个位置盖住目标时，换个位置能点到就算；任一测点落在别的元素（含浮层）上，该位置即不通过。
      // 是否被容器裁掉、需要横滑才看得到，由 collectStructure 的 action-clipped / action-scrolled-out 单独判定。
      let ok = false;
      for (const block of ['center', 'end'] as const) {
        // behavior: 'instant'：站点开了 scroll-behavior: smooth，平滑滚动时测点位置还没到
        el.scrollIntoView({ block, inline: 'nearest', behavior: 'instant' });
        const a = area(el.getBoundingClientRect());
        const cx = (a.left + a.right) / 2;
        const cy = (a.top + a.bottom) / 2;
        const i = 2.5;
        const hw = Math.min(opts.minTarget, a.right - a.left) / 2 - i;
        const hh = Math.min(opts.minTarget, a.bottom - a.top) / 2 - i;
        let here = true;
        // 5×5 网格采样（含四角、四边与中心），局部遮挡也能测到
        const steps = [-1, -0.5, 0, 0.5, 1];
        for (const x of steps.map((k) => cx + k * hw)) {
          for (const y of steps.map((k) => cy + k * hh)) {
            if (x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight) { here = false; continue; }
            const hit = document.elementFromPoint(x, y);
            if (!hit || !(hit === el || el.contains(hit))) here = false;
          }
        }
        if (here) { ok = true; break; }
      }
      for (const [p, l, t] of scrollers) { p.scrollLeft = l; p.scrollTop = t; }
      window.scrollTo({ left: sx, top: sy, behavior: 'instant' });
      return ok;
    };
    type Box = { left: number; right: number; top: number; bottom: number };
    const intersects = (a: Box, b: Box) => {
      const e = 0.5;
      return a.left < b.right - e && a.right > b.left + e && a.top < b.bottom - e && a.bottom > b.top + e;
    };
    // 区域中心那块 minTarget × minTarget 的方块（区域更小时取整块区域）
    const centralSquare = (a: Box): Box => {
      const cx = (a.left + a.right) / 2;
      const cy = (a.top + a.bottom) / 2;
      const hw = Math.min(opts.minTarget, a.right - a.left) / 2;
      const hh = Math.min(opts.minTarget, a.bottom - a.top) / 2;
      return { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh };
    };
    // 元素用绝对定位的 ::before / ::after 撑出的点击区（宿主坐标系 q 下）：宿主须已定位且自身不裁剪、伪元素可见可点、
    // 只做纯平移（matrix(1, 0, 0, 1, tx, ty)）；位置 = 宿主内边距盒 + 计算出的 left / top + 平移。取两者中更大的那个
    const pseudoBox = (el: Element, q: DOMRect): Box | null => {
      const hostCs = getComputedStyle(el);
      if (hostCs.position === 'static' || hostCs.overflow !== 'visible') return null;
      let best: Box | null = null;
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content === 'none' || ps.content === 'normal' || ps.position !== 'absolute' || ps.pointerEvents === 'none') continue;
        if (ps.display === 'none' || ps.visibility === 'hidden') continue;
        const m = /^matrix\(1, 0, 0, 1, (-?[\d.]+), (-?[\d.]+)\)$/.exec(ps.transform);
        if (ps.transform !== 'none' && !m) continue;
        const w = parseFloat(ps.width);
        const h = parseFloat(ps.height);
        const left = parseFloat(ps.left);
        const top = parseFloat(ps.top);
        if (![w, h, left, top].every(Number.isFinite)) continue;
        const x = q.left + (parseFloat(hostCs.borderLeftWidth) || 0) + left + (m ? parseFloat(m[1]) : 0);
        const y = q.top + (parseFloat(hostCs.borderTopWidth) || 0) + top + (m ? parseFloat(m[2]) : 0);
        const box = { left: x, right: x + w, top: y, bottom: y + h };
        if (!best || Math.min(w, h) > Math.min(best.right - best.left, best.bottom - best.top)) best = box;
      }
      return best;
    };
    const fixedLayer = (el: Element) => {
      for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).position === 'fixed') return true;
      }
      return false;
    };
    for (const el of targets) {
      const cs = getComputedStyle(el);
      // WCAG 例外：正文句子里的行内链接（所在文字块是段落、列表项、表格单元格等，且链接之外还有文字）
      if (el.tagName === 'A' && cs.display === 'inline') {
        const block = el.closest('p, li, dd, dt, td, th, blockquote, figcaption');
        const blockText = (block?.textContent || '').trim();
        if (block && blockText.length > (el.textContent || '').trim().length + 3) continue;
      }
      // 原生复选框 / 单选框常由外层 label 扩大点击区
      if (el.tagName === 'INPUT' && el.closest('label')) continue;
      const r = el.getBoundingClientRect();
      // sr-only 元素（如跳到主内容链接）平时被裁成 1px，聚焦时才展开，不算点击目标
      if (r.width <= 1 || r.height <= 1) continue;
      const own = Math.min(r.width, r.height);
      let min = own;
      // 点击区可以由绝对定位的 ::before / ::after 撑大（伪元素的点击落在宿主元素上，globals.css 的移动端规则）。
      // 承认的条件：伪元素位置按计算样式求出（pseudoBox）、罩住宿主、中心 44×44 方块不压到相邻目标的有效点击区，
      // 且对这块方块做网格命中测试（elementFromPoint）确实落在本元素上——被祖先裁掉、被别的层盖住都会暴露。
      if (own < opts.minTarget) {
        const a0 = pseudoBox(el, r);
        const hostCs = getComputedStyle(el);
        // 撑大的区域须罩住宿主的内边距盒（百分比宽高按内边距盒算，不含边框），否则谈不上「点击区变大」
        const covers = !!a0
          && a0.left <= r.left + (parseFloat(hostCs.borderLeftWidth) || 0) + 0.5
          && a0.right >= r.right - (parseFloat(hostCs.borderRightWidth) || 0) - 0.5
          && a0.top <= r.top + (parseFloat(hostCs.borderTopWidth) || 0) + 0.5
          && a0.bottom >= r.bottom - (parseFloat(hostCs.borderBottomWidth) || 0) - 0.5;
        // 本元素点击区中心的 44×44 方块不得压到相邻目标的有效点击区（其盒子，加上它撑大后的中心方块）；
        // 浮在页面上的固定定位元素随滚动位置盖住不同内容，不算相邻目标；0.5px 容差吸收亚像素误差
        const overlaps = !!a0 && targets.some((o) => {
          if (o === el || el.contains(o) || o.contains(el) || fixedLayer(o)) return false;
          const q = o.getBoundingClientRect();
          if (q.width <= 1 || q.height <= 1) return false;
          const ob = pseudoBox(o, q);
          const boxes = ob ? [q, centralSquare(ob)] : [q];
          return boxes.some((x) => intersects(centralSquare(a0), x));
        });
        if (a0 && covers && !overlaps && hitsCentralSquare(el, (q) => pseudoBox(el, q) ?? a0)) {
          // 实际可点区域 = 宿主盒与伪元素盒的并集
          const uw = Math.max(r.right, a0.right) - Math.min(r.left, a0.left);
          const uh = Math.max(r.bottom, a0.bottom) - Math.min(r.top, a0.top);
          min = Math.max(min, Math.min(uw, uh));
        }
      }
      // 亚像素宽度（如 43.99px）按 0.5px 容差计
      if (min < opts.minTarget - 0.5) smallTargets.push({ selector: sel(el), text: textOf(el), box: boxOf(el), min: Math.round(min) });
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

export interface StructureReport {
  h1: string[];
  /** 与 h1 同文的 h2–h6 */
  duplicateHeadings: string[];
  /** 没有任何链接的面包屑（只剩当前页名，和 h1 重复） */
  redundantBreadcrumbs: string[];
  /** 可操作项被裁剪祖先截掉：hidden/clip 祖先（够不着）或横向滚动容器（初始露出不足一个点击目标） */
  clippedActions: Array<{ selector: string; text: string; by: string; kind: 'hidden' | 'scroll' }>;
}

/** 页面标题结构与可操作项是否被容器裁掉（#774：重复标题、审批入口「藏在容器里」）。 */
export function collectStructure(): StructureReport {
  const norm = (t: string | null | undefined) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    // 收起的 <details> 里的内容（Chrome 以 content-visibility 隐藏，盒子尺寸仍在）、祖先透明度为 0 或不可见的，都不可见也不可点
    if ('checkVisibility' in el && !(el as HTMLElement).checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0 && !el.closest('[aria-hidden="true"], [inert]');
  };
  const desc = (el: Element) => {
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter((c) => c && !c.includes(':')).slice(0, 4);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls.length ? `.${cls.join('.')}` : ''}`;
  };

  // 1. 标题：h1 按读屏可读计数（含 sr-only）；同文判定只看可见标题
  // 计入读屏能读到的 h1：sr-only 的算，display:none / visibility:hidden / 透明祖先 / aria-hidden / 收起的 details 里的不算
  const h1s = Array.from(document.querySelectorAll('h1')).filter((h) => !h.closest('[aria-hidden="true"], [hidden]')
    && (!('checkVisibility' in h) || h.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })));
  // 按渲染出的文字比较（innerText 不含隐藏子节点）
  const h1 = h1s.map((h) => norm(h.innerText || h.textContent));
  const h1Set = new Set(h1.filter(Boolean));
  const duplicateHeadings = Array.from(document.querySelectorAll('h2, h3, h4, h5, h6'))
    .filter((h) => shown(h) && h1Set.has(norm((h as HTMLElement).innerText)))
    .map((h) => `${h.tagName.toLowerCase()} "${(h.textContent || '').trim().slice(0, 60)}"`);
  const redundantBreadcrumbs = Array.from(document.querySelectorAll('nav[aria-label*="breadcrumb" i]'))
    .filter((n) => shown(n) && n.querySelectorAll('a[href]').length === 0)
    .map((n) => `"${(n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)}"`);

  // 2. 可操作项被裁剪：逐个祖先比对盒子（只看当前滚动位置下的布局，不滚动任何容器）
  const clippedActions: StructureReport['clippedActions'] = [];
  // 与点击目标检查同一组可操作元素
  const q = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option]';
  for (const el of Array.from(document.querySelectorAll(q))) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.position === 'fixed') break;
      const pr = p.getBoundingClientRect();
      const ox = cs.overflowX;
      const oy = cs.overflowY;
      const outX = r.left < pr.left - 1 || r.right > pr.right + 1;
      const outY = r.top < pr.top - 1 || r.bottom > pr.bottom + 1;
      // overflow hidden / clip：截掉的部分永远够不着
      if (((ox === 'hidden' || ox === 'clip') && outX) || ((oy === 'hidden' || oy === 'clip') && outY)) {
        clippedActions.push({ selector: desc(el), text: ((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').trim().slice(0, 50), by: desc(p), kind: 'hidden' });
        break;
      }
      // 横向滚动容器：操作项在初始视图里露出的宽度不足一个点击目标（min(44px, 自身宽度)），要先横向滚动才点得到。
      // 纵向滚动的列表（侧栏等）是常规模式，不报
      const visibleW = Math.min(r.right, pr.right) - Math.max(r.left, pr.left);
      if ((ox === 'auto' || ox === 'scroll') && visibleW < Math.min(44, r.width) - 1) {
        clippedActions.push({ selector: desc(el), text: ((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').trim().slice(0, 50), by: desc(p), kind: 'scroll' });
        break;
      }
    }
  }
  return { h1, duplicateHeadings, redundantBreadcrumbs, clippedActions };
}
