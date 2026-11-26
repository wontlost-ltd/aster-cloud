/*
 * 显示排版渲染（ADR 0058 §7.7 第 3 条、§7.8，计划 T7）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}));

import { LayoutDisplayView, HIGHLIGHT_CLASS, MARKER_CLASS } from '@/components/policy/layout/layout-display-view';
import { LAYOUT, LAYOUT_DISPLAY } from '@/__tests__/fixtures/layout-read-fixture';

afterEach(() => cleanup());

const view = () => screen.getByRole('region', { name: 'policyLayout.displayLabel' });
const offsetOf = (needle: string) => LAYOUT_DISPLAY.indexOf(needle);

describe('LayoutDisplayView', () => {
  it('容器的可见文本恰为 display，带「不参与执行」的无障碍名称', () => {
    render(<LayoutDisplayView layout={LAYOUT} />);
    expect(view().textContent).toBe(LAYOUT_DISPLAY);
  });

  it('结构 span 有 data-layout-structural，title 与 aria-description 为其 canonical', () => {
    const { container } = render(<LayoutDisplayView layout={LAYOUT} />);
    const visible = [...container.querySelectorAll('[data-layout-structural]:not([data-layout-insertion])')];
    expect(visible.map((el) => [el.textContent, el.getAttribute('title'), el.getAttribute('aria-description')]))
      .toEqual([['模块 ', 'Module ', 'Module '], ['返回 ', 'Return ', 'Return ']]);
  });

  it('display 为空的结构 span 渲染插入标记，canonical 可经 title 与无障碍名称读到', () => {
    const { container } = render(<LayoutDisplayView layout={LAYOUT} />);
    const marks = container.querySelectorAll('[data-layout-insertion]');
    expect(marks).toHaveLength(1);
    expect(marks[0].getAttribute('title')).toBe('Rule ');
    expect(marks[0].textContent).toBe('');
    expect(screen.getByRole('img', { name: 'policyLayout.insertionLabel:{"canonical":"Rule "}' })).toBe(marks[0]);
  });

  it('highlight 区间内的字符带高亮类，区间外不带', () => {
    const start = offsetOf('decide');
    const { container } = render(<LayoutDisplayView layout={LAYOUT} highlight={{ start, end: start + 6 }} />);
    const hits = [...container.querySelectorAll('[data-layout-highlight]')];
    expect(hits.map((el) => el.textContent).join('')).toBe('decide');
    expect(hits.every((el) => el.className.includes(HIGHLIGHT_CLASS))).toBe(true);
    expect(view().textContent).toBe(LAYOUT_DISPLAY);
  });

  it('highlight 跨越结构 span 时在 span 边界切开，结构 span 保持一个整体', () => {
    const start = offsetOf('返回');
    const { container } = render(<LayoutDisplayView layout={LAYOUT} highlight={{ start, end: start + 4 }} />);
    expect([...container.querySelectorAll('[data-layout-highlight]')].map((el) => el.textContent)).toEqual(['返回 ', 'x']);
    expect(container.querySelectorAll('[data-layout-structural]:not([data-layout-insertion])')).toHaveLength(2);
  });

  it('markers 渲染为带 severity 类的下划线；重叠时 error 优先', () => {
    const x = offsetOf('x: Int');
    const { container } = render(
      <LayoutDisplayView
        layout={LAYOUT}
        markers={[
          { range: { start: x, end: x + 6 }, severity: 'warning' },
          { range: { start: x, end: x + 1 }, severity: 'error' },
        ]}
      />,
    );
    const errors = [...container.querySelectorAll('[data-layout-marker="error"]')];
    const warnings = [...container.querySelectorAll('[data-layout-marker="warning"]')];
    expect(errors.map((el) => el.textContent)).toEqual(['x']);
    expect(warnings.map((el) => el.textContent).join('')).toBe(': Int');
    expect(errors[0].className).toContain(MARKER_CLASS.error);
    expect(warnings[0].className).toContain(MARKER_CLASS.warning);
  });

  it('点击第 n 个 display 字符回调 onDisplayOffsetClick(n)', () => {
    const onClick = vi.fn();
    const { container } = render(<LayoutDisplayView layout={LAYOUT} onDisplayOffsetClick={onClick} />);
    const n = offsetOf('decide') + 2;
    fireEvent.click(container.querySelector(`[data-display-offset="${n}"]`)!);
    expect(onClick).toHaveBeenCalledWith(n);
    expect(container.querySelector(`[data-display-offset="${n}"]`)!.textContent).toBe('c');
  });

  it('按码点切分：emoji 的代理对不被拆开，偏移按 UTF-16 计', () => {
    const onClick = vi.fn();
    const { container } = render(<LayoutDisplayView layout={LAYOUT} onDisplayOffsetClick={onClick} />);
    const emoji = offsetOf('🙂');
    const el = container.querySelector(`[data-display-offset="${emoji}"]`)!;
    expect(el.textContent).toBe('🙂');
    expect(container.querySelector(`[data-display-offset="${emoji + 1}"]`)).toBeNull();
    expect(container.querySelector(`[data-display-offset="${emoji + 2}"]`)!.textContent).toBe('\n');
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledWith(emoji);
  });

  it('不可点击时不按字符切分（内容 span 是一个文本节点）', () => {
    const { container } = render(<LayoutDisplayView layout={LAYOUT} />);
    expect(container.querySelector('[data-display-offset]')).toBeNull();
    const content = container.querySelectorAll('[data-layout-content]');
    expect(content[1].childNodes).toHaveLength(1);
  });
});

describe('LayoutDisplayView：区间端点落在代理对中间', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it.each([
    ['highlight 起点在 emoji 中间', (e: number) => ({ highlight: { start: e + 1, end: e + 3 } })],
    ['highlight 终点在 emoji 中间', (e: number) => ({ highlight: { start: e - 1, end: e + 1 } })],
    ['marker 只覆盖 emoji 的低位代理项', (e: number) => ({ markers: [{ range: { start: e + 1, end: e + 2 }, severity: 'warning' as const }] })],
  ])('%s：不产生孤立代理项，emoji 整体落在区间内', (_name, props) => {
    const e = offsetOf('🙂');
    const { container } = render(<LayoutDisplayView layout={LAYOUT} {...props(e)} />);
    const pieces = [...container.querySelectorAll('[data-layout-highlight], [data-layout-marker]')];
    expect(pieces.length).toBeGreaterThan(0);
    for (const el of pieces) expect(lone.test(el.textContent ?? ''), el.textContent ?? '').toBe(false);
    expect(pieces.some((el) => el.textContent?.includes('🙂'))).toBe(true);
    expect(view().textContent).toBe(LAYOUT_DISPLAY);
  });
});

// 被隐藏的名字转义（ADR 0058 修订 3 E7，ADR 0059 修订 5 L10a 三元组）：转义名有专门样式与悬停，反引号不画插入标记。
describe('LayoutDisplayView：被隐藏的名字转义', () => {
  const tick = { canonical: '`', display: '' };
  const POEM = {
    v: 1 as const,
    spans: [
      { text: '床前' }, { canonical: ' ', display: '' }, tick, { text: '当' }, tick, { canonical: ' ', display: '' }, { text: '明月光' },
    ],
  };

  it('转义名用专门样式，title 与 aria-description 给出原文 `当` 与「名字，不是关键词」；反引号不画插入标记（快照）', () => {
    const { container } = render(<LayoutDisplayView layout={POEM} />);
    expect(view().textContent).toBe('床前当明月光');
    const escaped = container.querySelectorAll('[data-layout-hidden-escape]');
    expect(escaped).toHaveLength(1);
    expect(escaped[0].getAttribute('data-layout-hidden-escape')).toBe('`当`');
    expect(escaped[0].getAttribute('title')).toBe('policyLayout.hiddenEscapeLabel:{"canonical":"`当`"}');
    expect(escaped[0].getAttribute('aria-description')).toBe(escaped[0].getAttribute('title'));
    // 两个隐藏空格照旧是插入标记；两个反引号不画
    expect([...container.querySelectorAll('[data-layout-insertion]')].map((el) => el.getAttribute('title'))).toEqual([' ', ' ']);
    expect(view().innerHTML).toMatchSnapshot();
  });

  it('形状不合 L10a（只有一个反引号结构 span）：按普通结构 span 渲染，不标转义名', () => {
    const broken = { v: 1 as const, spans: [{ text: '床前' }, tick, { text: '当`明月光' }] };
    const { container } = render(<LayoutDisplayView layout={broken} />);
    expect(container.querySelector('[data-layout-hidden-escape]')).toBeNull();
    expect(container.querySelectorAll('[data-layout-insertion]')).toHaveLength(1);
  });

  it('没有反引号结构 span 的排版：DOM 与引入转义之前相同（无转义标记）', () => {
    const { container } = render(<LayoutDisplayView layout={LAYOUT} />);
    expect(container.querySelector('[data-layout-hidden-escape]')).toBeNull();
  });
});
