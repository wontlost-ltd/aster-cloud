import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import ts from 'typescript';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';

/**
 * 复核面板的 i18n 命名空间与键，必须在**真实文案树**里解析得到。
 *
 * <h2>为什么组件测试挡不住这类缺陷</h2>
 *
 * <p>组件测试把 `useTranslations` mock 成 key 直返（`(k) => k`），于是命名空间
 * 前缀**根本不参与任何断言**：把 `useTranslations('policyReview')` 写成
 * `'demoPage.policyReview'`，60+ 条组件用例照样全绿，而真实页面上每个词都会
 * 显示成 `demoPage.policyReview.accept` 这样的原始 key（next-intl 的
 * `getMessageFallback` 兜底成 key 路径，不抛错）。
 *
 * <h2>★为什么用「运行时采集」而不是正则扫源码</h2>
 *
 * <p>上一版用正则从源码提取命名空间与 `t('x')` 键。对抗性验证证明那不可靠：
 *
 * <ul>
 *   <li>``t(`subtitle`)`` 模板字面量 → 正则不匹配，该键被**静默跳过**；
 *       同一个缺陷改用单引号就报红——是否报红取决于引号风格，
 *       而不是缺陷是否存在</li>
 *   <li>第二个 `useTranslations('noSuchNamespace')` → `.exec()` 只取首个匹配，
 *       完全看不见</li>
 * </ul>
 *
 * <p>现在改为把 `useTranslations` 换成**记录器**，渲染组件并走遍各分支，
 * 采集到的 `(namespace, keys)` 全部来自**真实调用**——与写法无关，
 * 也能看见任意多个 `useTranslations`。
 */

/** 采集到的真实调用：命名空间 → 该命名空间下用到的键。 */
const collected = new Map<string, Set<string>>();

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => {
    if (!collected.has(ns)) collected.set(ns, new Set());
    return (key: string) => {
      collected.get(ns)!.add(key);
      return `${ns}.${key}`;
    };
  },
}));

import { PolicyReviewPanel } from '@/components/policy/policy-review-panel';

const HASH = 'a'.repeat(64);
const LOCALES = ['en', 'zh', 'de', 'hi'] as const;

/** 按点分路径在文案树里取值。 */
function resolve(tree: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, seg) => (acc as Record<string, unknown> | undefined)?.[seg],
    tree,
  );
}

function stubFetch(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => body,
  }));
}

/**
 * 渲染组件并走遍所有分支，把每条文案都"用"一次。
 *
 * <p>没走到的分支，其键不会被采集——所以这里必须覆盖：
 * 有待办 / 空队列 / 队列不可用 / 非复核人 / 已有结论 / 提交出错。
 */
async function exerciseAllBranches() {
  const item = {
    text: '10000', nodeId: '$.a', span: { start: 0, end: 5 },
    reason: 'r', contentHash: HASH,
  };
  // ★nodeId 与队列 item **相同**且 contentHash **不同** → 触发 staleNote 分支。
  //   用 '$.b' 的话该分支走不到，staleNote 就采集不到——
  //   而"没采集到"会被误读成"组件没用这个键"。
  const proof = {
    id: 'p1', nodeId: '$.a', contentHash: 'c'.repeat(64), verdict: 'VERIFIED',
    reason: '已核对', subjectKind: 'domain_expert', subjectUserId: 'alice',
    text: '30 days', span: { start: 0, end: 7 }, recordedAt: '2026-09-14T00:00:00Z',
  };
  const base = {
    items: [item], counts: { verified: 1, reviewRequired: 1, rejected: 1 },
    queueStatus: 'ok', canReview: true, subjectKind: 'domain_expert',
    // 三条：一条同 nodeId（走条目内 + staleNote）；两条**同为队列外且同 nodeId**
    // （走 recordedTitle + supersededNote——后者要求该节点不止一条结论）。
    proofs: [
      proof,
      { ...proof, id: 'p2', nodeId: '$.z', text: '90 days' },
      { ...proof, id: 'p3', nodeId: '$.z', text: '90 days', verdict: 'REJECTED' },
    ],
  };

  // ① 有待办 + 队列外结论 + 可签字（覆盖大部分键）
  stubFetch(base);
  render(<PolicyReviewPanel policyId="p1" />);
  await waitFor(() => expect(screen.getByText('policyReview.title')).toBeDefined());
  // 空理由提交 → 触发 reasonRequired
  fireEvent.click(screen.getAllByText('policyReview.accept')[0]);
  await waitFor(() => expect(screen.getByText('policyReview.reasonRequired')).toBeDefined());
  cleanup();

  // ② 空队列（empty）
  stubFetch({ ...base, items: [], proofs: [] });
  render(<PolicyReviewPanel policyId="p1" />);
  await waitFor(() => expect(screen.getByText('policyReview.empty')).toBeDefined());
  cleanup();

  // ③ 队列不可用（queueUnavailable）
  stubFetch({ ...base, items: [], proofs: [], queueStatus: 'engine_error' });
  render(<PolicyReviewPanel policyId="p1" />);
  await waitFor(() => expect(screen.getByText('policyReview.queueUnavailable')).toBeDefined());
  cleanup();

  // ④ 非复核人（notReviewer）
  stubFetch({ ...base, canReview: false });
  render(<PolicyReviewPanel policyId="p1" />);
  await waitFor(() => expect(screen.getByText('policyReview.notReviewer')).toBeDefined());
  cleanup();

  // ⑤ 加载失败（loadFailed）
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false, status: 500, json: async () => ({}),
  }));
  render(<PolicyReviewPanel policyId="p1" />);
  await waitFor(() => expect(screen.getByText('policyReview.loadFailed')).toBeDefined());
  cleanup();

  // ⑥ 提交失败（submitFailed / submitting）
  vi.stubGlobal('fetch', vi.fn().mockImplementation(
    (_u: string, init?: { method?: string }) => Promise.resolve({
      ok: init?.method !== 'POST', status: init?.method === 'POST' ? 403 : 200,
      json: async () => base,
    }),
  ));
  render(<PolicyReviewPanel policyId="p1" />);
  await waitFor(() => expect(screen.getAllByText('policyReview.accept')[0]).toBeDefined());
  fireEvent.change(screen.getByLabelText('policyReview.reasonLabel'),
    { target: { value: '理由。' } });
  fireEvent.click(screen.getAllByText('policyReview.accept')[0]);
  await waitFor(() => expect(screen.getByText('policyReview.submitFailed')).toBeDefined());
  cleanup();
}

afterEach(() => vi.unstubAllGlobals());

/**
 * 静态扫描：面板及其同目录依赖里所有译器调用的字面量键。
 *
 * <p>返回 `{ keys, dynamic }`——`dynamic` 非空表示源码里有静态分析
 * 跟不动的写法（把译器当参数传、解构取得等），调用方应当据此**失败**。
 */
function staticScan(): { keys: string[]; dynamic: string[] } {
    const dir = resolvePath(process.cwd(), 'src/components/policy');
  // ★取 **glob ∪ import 图** 的并集，两种漏法都堵：
  //   只靠文件名前缀 → 子组件叫 `review-item.tsx` 就扫不到（该约定
  //     没有任何 lint 规则强制，而这恰是最自然的命名）；
  //   只靠 import 图 → 带前缀但暂时无人 import 的文件会被漏掉。
  const entry = 'policy-review-panel.tsx';
  const files = new Set<string>(
    readdirSync(dir).filter(
      (f) => f.startsWith('policy-review-panel') && f.endsWith('.tsx')
             && !f.includes('.test.'),
    ),
  );
  (function follow(file: string) {
    const full = resolvePath(dir, file);
    if (!existsSync(full)) return;
    const src = readFileSync(full, 'utf8');
    for (const m of src.matchAll(/from\s+'\.\/([\w.-]+)'/g)) {
      const base = m[1].replace(/\.tsx?$/, '');
      for (const ext of ['.tsx', '.ts']) {
        const cand = base + ext;
        if (existsSync(resolvePath(dir, cand)) && !files.has(cand)) {
          files.add(cand);
          follow(cand);
        }
      }
    }
  })(entry);
  expect([...files], '前置：至少扫到面板自身').toContain(entry);

  const keys: string[] = [];
  const dynamic: string[] = [];
  for (const f of files) {
    const sf = ts.createSourceFile(
      f, readFileSync(resolvePath(dir, f), 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
    );

    // ★识别条件是"**由 useTranslations() 返回的绑定**"，不是"名叫 t"。
    //   硬编码标识符名时，改名或起别名都会静默降为零键，那时只剩
    //   `keys.length > 10` 这一条脆弱前置守卫兜底。
    // ★**不动点迭代**：反复遍历直到译器集合不再增长。
    //   单次遍历依赖声明顺序——`const tAlias = t` 若写在
    //   `const t = useTranslations()` **之前**就会被漏掉。
    const translators = new Set<string>();
    let grew = true;
    while (grew) {
      const before = translators.size;
      (function findTranslators(n: ts.Node) {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
          if (ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression)
              && n.initializer.expression.text === 'useTranslations') {
            translators.add(n.name.text);
          } else if (ts.isIdentifier(n.initializer) && translators.has(n.initializer.text)) {
            translators.add(n.name.text);            // 别名：const tAlias = t;
          }
        }
        // 后置赋值：`let tLate; tLate = t;`
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isIdentifier(n.left) && ts.isIdentifier(n.right)
            && translators.has(n.right.text)) {
          translators.add(n.left.text);
        }
        n.forEachChild(findTranslators);
      })(sf);
      grew = translators.size > before;
    }

    (function walk(n: ts.Node) {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
          && translators.has(n.expression.text)) {
        const arg = n.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) keys.push(arg.text);
        // 动态键必须让门禁**失败**，而不是静默跳过——否则又回到
        // "写法决定是否报红"。
        else dynamic.push(n.getText().slice(0, 60));
      }
      n.forEachChild(walk);
    })(sf);
  }
  return { keys, dynamic };
}

/** 只要键集合的便捷入口。 */
function staticKeysOf(): Set<string> {
  return new Set(staticScan().keys);
}

describe('复核面板 i18n 命名空间（运行时采集）', () => {
  it('前置：确实采集到了唯一一个命名空间与足够多的键', async () => {
    // 防守本门禁自身：采集为空时，下面的断言会在空集合上恒真。
    await exerciseAllBranches();

    expect(collected.size, '应当**恰好一个** useTranslations 命名空间').toBe(1);

    // ★必须显式断言**每个分支独有的键**都被采集到。
    //
    //   本门禁的全部判别力建立在"六个分支都真的渲染过"之上，而唯一的
    //   数量守卫是宽松下界：实测只走分支① 仍能采集 14 个键 > 10，
    //   守卫不响；丢掉的六个键随后被静态扫描的并集补回，正向/反向/
    //   四语一致性断言全部照常绿。于是有人重构 exerciseAllBranches
    //   （删掉一个超时的 waitFor、提取 helper 时漏几段）时，门禁会
    //   **静默退化**成纯静态扫描器——它自称的"运行时采集不受写法影响"
    //   这一核心优势归零，且没有任何信号。
    //
    //   清单只列**分支独有**的键：新增键不会误伤（不拦正确改动），
    //   但少走任何一个分支都会立刻响亮失败。
    const RUNTIME_REQUIRED = [
      'empty',            // 分支② 空队列
      'queueUnavailable', // 分支③ 队列不可用
      'notReviewer',      // 分支④ 非复核人
      'loadFailed',       // 分支⑤ 加载失败
      'submitFailed',     // 分支⑥ 提交失败
      'submitting',       // 分支⑥ 提交中
      'staleNote',        // 内容已变更
      'supersededNote',   // 同节点多条结论
      'recordedTitle',    // 队列外结论区
      'reasonRequired',   // 空理由拦截
    ] as const;
    const [, collectedKeys] = [...collected.entries()][0];
    const notExercised = RUNTIME_REQUIRED.filter((k) => !collectedKeys.has(k));
    expect(notExercised,
      `这些分支没被 exerciseAllBranches 走到，运行时保护已失效：${notExercised.join(',')}`)
      .toEqual([]);
    const [ns, keys] = [...collected.entries()][0];
    expect(ns).toBe('policyReview');
    // ★不写死精确数量。写 `toBe(19)` 会拦下**正确**改动
    //   （新增一个键并补齐四语翻译也报红），而真正的缺陷
    //   （新增键 + 新增未覆盖分支）它照样看不见——判别力与噪声方向反了。
    //   数量守卫只用于"采集确实发生了"，闭合性由下面的双向断言保证。
    expect(keys.size, `采集到的键：${[...keys].sort().join(',')}`).toBeGreaterThan(10);
  });

  it.each(LOCALES)('%s：命名空间必须存在于文案树中', (locale) => {
    const [ns] = [...collected.keys()];
    const node = resolve(DEMO_SUPPLEMENT[locale], ns);
    expect(node, `${locale} 缺少命名空间 ${ns}——界面会显示原始 key`).toBeDefined();
    expect(typeof node).toBe('object');
  });

  it.each(LOCALES)('%s：组件真实用到的每个键都必须有非空文案', (locale) => {
    const [ns, keys] = [...collected.entries()][0];
    const missing: string[] = [];
    for (const k of keys) {
      const v = resolve(DEMO_SUPPLEMENT[locale], `${ns}.${k}`);
      if (typeof v !== 'string' || v.trim() === '') missing.push(k);
    }
    expect(missing, `${locale} 缺失或为空的键`).toEqual([]);
  });

  it('★文案树里的键必须都被用到（反向闭合，防僵尸文案）', () => {
    const [ns, keys] = [...collected.entries()][0];
    const treeKeys = Object.keys((resolve(DEMO_SUPPLEMENT.en, ns) ?? {}) as object);

    // ★"被用到"必须取 **运行时 ∪ 静态** 的并集。
    //   只比运行时的话，一个**只在未执行分支里用到**的键（但四语翻译齐全，
    //   完全合法）会被误判成僵尸文案——拦下正确改动。
    //   静态扫描恰好看得见那些分支，两者并集才是"组件真正用到的键"。
    const staticKeys = staticKeysOf();
    const used = new Set([...keys, ...staticKeys]);

    // 与正向断言合起来构成**双向闭合**，堵住两种形态：
    //   ① 补了翻译但源码零引用（僵尸文案）→ 本断言变红
    //   ② 源码引用了但没补翻译 → 正向断言变红
    //
    // ★**堵不住第三种**：源码在**死代码**里引用且补齐了翻译。
    //   静态扫描只能证明"源码存在引用"，无法证明"该引用可达"——
    //   这是静态分析的固有边界，不在本门禁的能力范围内。
    //   后果有限（文案膨胀、误导后续维护者），但别把承诺说大：
    //   删 feature 时若残留死分支，本门禁会一直替那批文案背书为"仍在使用"。
    //   死代码清理应当依赖 lint / 覆盖率工具，而不是这里。
    const unused = treeKeys.filter((k) => !used.has(k));
    expect(unused, `文案树里有键从未被组件用到：${unused.join(',')}`).toEqual([]);
  });

  it('★源码里所有 t() 的键都必须在文案树里（静态兜底，AST 扫描）', () => {
    // 运行时记录器只看得见**执行过**的分支；静态扫描看得见未执行的分支。
    // 二者互补：记录器负责"写法无关、命名空间准确"，静态负责"覆盖盲区"。
    const { keys, dynamic } = staticScan();

    expect(dynamic, 't() 的键必须是字面量，否则静态兜底无法校验').toEqual([]);
    expect(keys.length, '前置：确实扫到了译器调用').toBeGreaterThan(10);

    const [ns, runtimeKeys] = [...collected.entries()][0];
    const missing = [...new Set(keys)].filter(
      (k) => typeof resolve(DEMO_SUPPLEMENT.en, `${ns}.${k}`) !== 'string',
    );
    expect(missing, `源码用到但文案树里没有的键：${missing.join(',')}`).toEqual([]);

    // ★静态与运行时**必须互相覆盖**——这是根治"枚举形态"的办法。
    //   绑定识别总有漏形态（把译器当函数参数传、经对象解构取得……），
    //   而且是**静默**漏掉，比漏掉本身更糟。
    //   运行时采集器不受写法影响（它替换的是 useTranslations 本身），
    //   所以凡是运行时见过的键，静态也必须见到；见不到就说明源码用了
    //   静态分析跟不动的写法——此时应当**响亮失败**并要求改写，
    //   而不是放行。这样新形态无需逐个补，也不会静默溜过去。
    const staticKeys = new Set(keys);
    const invisible = [...runtimeKeys].filter((k) => !staticKeys.has(k));
    expect(invisible,
      `这些键运行时用到了但静态扫描看不见（可能把译器当参数传递或解构取得）：${invisible.join(',')}`)
      .toEqual([]);
  });

  it('四语的键集合必须完全一致（缺译会 fail-open 成 en 或原始 key）', () => {
    const [ns] = [...collected.keys()];
    const sets = LOCALES.map(
      (l) => Object.keys((resolve(DEMO_SUPPLEMENT[l], ns) ?? {}) as object).sort(),
    );
    for (let i = 1; i < sets.length; i++) {
      expect(sets[i], `${LOCALES[i]} 与 en 的键集合不一致`).toEqual(sets[0]);
    }
  });
});
