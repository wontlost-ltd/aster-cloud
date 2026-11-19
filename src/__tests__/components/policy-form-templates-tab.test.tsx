import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

/**
 * #791：带 requires 的模板在能力不满足时锁定（不可点击、说明原因、链接文档）；普通模板照常可点。
 */

vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((k: string) => k, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { TemplatesTab } from '@/components/policy/policy-form/templates-tab';
import { POLICY_EXAMPLES } from '@/data/policy-examples';
import { JINGYESI_TEMPLATE_ID } from '@/data/policy-example-showcase';

const NONE = { structuredAuthoring: false, structuralAliases: false };
const SHOWCASE_NAME = 'Quiet Night Thoughts (Chinese showcase)';

describe('TemplatesTab gating', () => {
  it('without structured authoring: showcase is locked with a reason and docs links; content-only templates stay clickable', () => {
    const onSelect = vi.fn();
    render(<TemplatesTab uiLocale="en" capabilities={NONE} onSelect={onSelect} />);

    const locked = screen.getByTestId(`template-locked-${JINGYESI_TEMPLATE_ID}`);
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    expect(within(locked).queryByRole('button')).toBeNull();
    expect(within(locked).getByText('templateLocked')).toBeTruthy();
    expect(within(locked).getByText('templateRequiresStructuredAuthoring')).toBeTruthy();
    expect(within(locked).queryByText('templateRequiresStructuralAliases')).toBeNull();
    expect(within(locked).getByText('templateDocsAdmin').getAttribute('href')).toBe('/docs/guides/structured-authoring-admin');
    expect(within(locked).getByText('templateDocsLayouts').getAttribute('href')).toBe('/docs/guides/display-layouts');
    fireEvent.click(within(locked).getByText(SHOWCASE_NAME));
    expect(onSelect).not.toHaveBeenCalled();

    // 原有六个普通模板全部是可点的按钮，点击即选中
    const contentOnly = POLICY_EXAMPLES.filter((e) => e.id !== JINGYESI_TEMPLATE_ID);
    expect(screen.getAllByRole('button')).toHaveLength(contentOnly.length);
    fireEvent.click(screen.getByRole('button', { name: /Basic starter/ }));
    expect(onSelect).toHaveBeenCalledWith(contentOnly[0]);
    expect(screen.queryByText('templateIncludesExtras')).toBeNull();
  });

  it('with structured authoring: showcase is a normal button that says it also sets aliases and a layout', () => {
    const onSelect = vi.fn();
    render(<TemplatesTab uiLocale="en" capabilities={{ structuredAuthoring: true, structuralAliases: false }} onSelect={onSelect} />);

    expect(screen.queryByTestId(`template-locked-${JINGYESI_TEMPLATE_ID}`)).toBeNull();
    const button = screen.getByRole('button', { name: new RegExp(SHOWCASE_NAME.replace(/[()]/g, '\\$&')) });
    expect(within(button).getByText('templateIncludesExtras')).toBeTruthy();
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith(POLICY_EXAMPLES.find((e) => e.id === JINGYESI_TEMPLATE_ID));
  });

  it('shows Hindi metadata for the showcase in the hi UI', () => {
    render(<TemplatesTab uiLocale="hi" capabilities={NONE} onSelect={vi.fn()} />);
    expect(screen.getByText('शांत रात के विचार (चीनी उदाहरण)')).toBeTruthy();
  });
});
