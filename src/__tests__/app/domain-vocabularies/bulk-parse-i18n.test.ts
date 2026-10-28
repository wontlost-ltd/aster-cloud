/**
 * 批量导入客户端解析错误、执行页错误与快照页文案的本地化（#634 #640）：
 * 解析只产出问题码，界面按码取文案；en/de/hi 不出现中文，de 不出现原来的英文原文。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import {
  parseBulkInput,
  parseFindingText,
  type ParseFinding,
} from '@/app/[locale]/(dashboard)/domain-vocabularies/bulk-parse';

const ROOT = path.resolve(__dirname, '../../../..');
const PKG = {
  en: 'node_modules/@aster-cloud/ui-messages/en-US.json',
  zh: 'node_modules/@aster-cloud/ui-messages/zh-CN.json',
  de: 'node_modules/@aster-cloud/ui-messages/de-DE.json',
  hi: 'node_modules/@aster-cloud/ui-messages-hi/hi-IN.json',
} as const;
type Loc = keyof typeof PKG;

/** 与运行时 request.ts 同口径合并：en 底座 → 当前语言包 → en 补充 → 当前语言补充。 */
function messagesFor(locale: Loc) {
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  let messages = deepMergeMessages(read(PKG.en), read(PKG[locale]));
  messages = deepMergeMessages(messages, DEMO_SUPPLEMENT.en);
  return deepMergeMessages(messages, DEMO_SUPPLEMENT[locale]);
}

function translator(locale: Loc, namespace: string) {
  const t = createTranslator({ locale, messages: messagesFor(locale), namespace: namespace as never }) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  return (key: string, values?: Record<string, string | number>) => t(key, values);
}

const CJK = /[㐀-鿿＀-￯]/;
const HEADER = 'domain,locale,kind,canonical,localized,parentCanonical';

/** 每种客户端解析问题各一例。 */
const CASES: Record<string, string> = {
  invalid_json: '[{"kind": ',
  csv_needs_header: HEADER,
  row_not_object: '[1]',
  column_count: `${HEADER}\nfinance,de,struct`,
  field_required: `${HEADER}\n,de,struct,Loan,Kredit,`,
  kind_invalid: `${HEADER}\nfinance,de,table,Loan,Kredit,`,
  parent_required: `${HEADER}\nfinance,de,field,amount,Betrag,`,
  domain_format: `${HEADER}\nE2E 1029!,de,struct,Loan,Kredit,`,
  locale_format: `${HEADER}\nfinance,not a locale!!,struct,Loan,Kredit,`,
};

// 修复前直接显示给用户的英文原文（de 界面里不应再出现）。
const RAW_ENGLISH = [
  'Invalid JSON syntax', 'CSV needs a header row', 'Row is not an object', 'columns, got',
  'is required', 'must be one of', 'parentCanonical is required for kind=field',
];

function findingFor(issue: string): ParseFinding {
  const [finding] = parseBulkInput(CASES[issue]!).errors;
  return finding!;
}

describe('parseBulkInput：只产出问题码与参数', () => {
  it.each(Object.keys(CASES))('%s', (issue) => {
    expect(findingFor(issue).issue).toBe(issue);
  });

  it('列数不符带期望 / 实际列数；缺必填列带列名；整段问题的行号为 0', () => {
    expect(findingFor('column_count')).toEqual({ row: 2, issue: 'column_count', values: { expected: 6, actual: 3 } });
    expect(findingFor('field_required')).toEqual({ row: 2, issue: 'field_required', values: { field: 'domain' } });
    expect(findingFor('invalid_json').row).toBe(0);
  });

  it('合法行照常解析（aliases 用 | 分隔，空的可选列省略）', () => {
    const { rows, errors } = parseBulkInput('domain,locale,kind,canonical,localized,aliases\nfinance,de,struct,Loan,Kredit,darlehen|kredit2');
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ domain: 'finance', locale: 'de', kind: 'struct', canonical: 'Loan', localized: 'Kredit', aliases: ['darlehen', 'kredit2'] }]);
  });
});

describe('批量导入解析错误按问题码本地化（#634）', () => {
  for (const locale of Object.keys(PKG) as Loc[]) {
    it(`[${locale}] 每种问题都渲染为文案（不是 key 路径）`, () => {
      const t = translator(locale, 'domainVocabularies.bulk');
      for (const issue of Object.keys(CASES)) {
        const text = parseFindingText(findingFor(issue), t);
        expect(text, issue).not.toMatch(/parseIssues\.|domainVocabularies\./);
        if (locale !== 'zh') expect(text, issue).not.toMatch(CJK);
        if (locale === 'de') for (const raw of RAW_ENGLISH) expect(text, issue).not.toContain(raw);
      }
    });
  }

  it('行级问题带行号前缀，整段问题不带「#0」', () => {
    const t = translator('de', 'domainVocabularies.bulk');
    expect(parseFindingText(findingFor('column_count'), t)).toBe('#2: 6 Spalten erwartet, 3 gefunden.');
    expect(parseFindingText(findingFor('invalid_json'), t)).toBe('Die Eingabe ist kein gültiges JSON.');
  });
});

describe('执行页错误与表单提示（#634 #638）', () => {
  const KEYS = ['invalidInputObject', 'inputTypeExtractionFailed', 'entryRuleRequired', 'nonObjectInputInForm'];
  for (const locale of Object.keys(PKG) as Loc[]) {
    it(`[${locale}] 有本地化文案`, () => {
      const t = translator(locale, 'policies.execute');
      const en = translator('en', 'policies.execute');
      for (const key of KEYS) {
        const text = t(key);
        expect(text, key).not.toMatch(/^policies\.execute\./);
        if (locale !== 'zh') expect(text, key).not.toMatch(CJK);
        if (locale !== 'en') expect(text, key).not.toBe(en(key));
      }
      expect(t('invalidInputObject')).not.toContain('Input must be a valid object');
    });
  }
});

describe('快照页文案（#640）', () => {
  it('de 回滚按钮语法正确', () => {
    expect(translator('de', 'domainVocabularies.snapshotsView')('diff.rollback')).toBe('Auf diesen Snapshot zurücksetzen');
  });

  it.each(['zh', 'hi'] as const)('%s 回滚按钮是本地化文案', (locale) => {
    const text = translator(locale, 'domainVocabularies.snapshotsView')('diff.rollback');
    expect(text).not.toBe(translator('en', 'domainVocabularies.snapshotsView')('diff.rollback'));
    expect(text).not.toContain('rollen zurück');
  });

  it('快照页声明本地化标题（与其它应用内页面同一模板；键存在性由 page-metadata.test 统一校验）', () => {
    const page = fs.readFileSync(path.join(ROOT, 'src/app/[locale]/(dashboard)/domain-vocabularies/snapshots/page.tsx'), 'utf8');
    expect(page).toMatch(/export const generateMetadata = localizedTitle\('domainVocabularies\.snapshotsView', 'title'\)/);
    expect(translator('de', 'domainVocabularies.snapshotsView')('title')).toBe('Vokabular-Snapshots');
  });
});
