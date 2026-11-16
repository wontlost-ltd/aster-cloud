/**
 * 文档代码高亮主题（rehype-pretty-code / Shiki），next.config.ts 与对比度单测共用这一处定义。
 *
 * 选 GitHub 高对比度两套（#774 设计决策 2）：
 * - github-light / github-dark 有 token 低于 WCAG AA 4.5:1（注释 #6a737d 在暗底 4.13，橙色 #e36209 在浅底 3.48）；
 * - 高对比度版与原主题同一配色家族、同样的 token 语义映射，读者看到的配色风格基本不变，
 *   在本站代码块可能落的全部表面上（浅：bg / bg-subtle / bg-muted，暗：同三档）每个 token 都 ≥4.5:1
 *   （见 src/__tests__/docs/code-theme-contrast.test.ts）；
 * - 备选 a11y-light / a11y-dark 不在 Shiki 内置主题里，需另外引入并维护主题 JSON，收益不抵成本。
 *
 * github-dark-high-contrast 里有 3 组「自带背景色」的 token 仍低于 4.5:1（diff 删除 / 修改行、carriage-return 标记）。
 * 这里在构建期生成一份修正版主题对象：同色相加深背景或换前景，其余 token 原样保留。单测直接核对这份对象，
 * 所以核对的就是读者实际看到的配色。
 */
import githubDarkHighContrast from 'shiki/themes/github-dark-high-contrast.mjs';

interface TokenColor {
  scope?: string | string[];
  settings?: { foreground?: string; background?: string; fontStyle?: string };
}

interface ThemeJson {
  name: string;
  colors?: Record<string, string>;
  tokenColors?: TokenColor[];
  [key: string]: unknown;
}

/** 修正项：按 scope 命中，只替换给定的原色（小写），值为替换色 */
export const DARK_TOKEN_PATCHES: ReadonlyArray<{ scope: string; foreground?: [string, string]; background?: [string, string] }> = [
  // 白字配粉底 2.12:1 → 近黑字 9.23:1
  { scope: 'carriage-return', foreground: ['#ffffff', '#0a0c10'] },
  // 删除行 #ffb1af on #ad0116 4.35:1 → 5.82:1
  { scope: 'markup.deleted', background: ['#ad0116', '#8a0012'] },
  // 修改行 #ffb757 on #a74c00 3.31:1 → 5.12:1
  { scope: 'markup.changed', background: ['#a74c00', '#7a3700'] },
];

export function patchTheme(theme: ThemeJson, name: string): ThemeJson {
  return {
    ...theme,
    name,
    tokenColors: (theme.tokenColors ?? []).map((tc) => {
      const scopes = ([] as string[]).concat(tc.scope ?? []);
      const patch = DARK_TOKEN_PATCHES.find((p) => scopes.includes(p.scope));
      if (!patch || !tc.settings) return tc;
      const settings = { ...tc.settings };
      if (patch.foreground && settings.foreground?.toLowerCase() === patch.foreground[0]) settings.foreground = patch.foreground[1];
      if (patch.background && settings.background?.toLowerCase() === patch.background[0]) settings.background = patch.background[1];
      return { ...tc, settings };
    }),
  };
}

export const DARK_CODE_THEME = patchTheme(githubDarkHighContrast as unknown as ThemeJson, 'github-dark-high-contrast-aa');

export const CODE_THEME = {
  light: 'github-light-high-contrast',
  dark: DARK_CODE_THEME,
} as const;
