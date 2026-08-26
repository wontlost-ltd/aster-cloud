/**
 * check-message-keys.mjs — 代码里的 `t('key')` ↔ 文案真相源 的存在性校验。
 *
 * <h3>为什么需要它（既有两个 gate 的盲区）</h3>
 * - `check-locales.ts` 比的是**语言之间**的结构一致（zh/de/hi 是否跟得上 en）
 * - `check-locale-coverage.mjs` 比的是**翻译覆盖率**（叶子键非空占比）
 *
 * 两者都以 **en 为骨架**。于是「一个键**所有语言都没有**」对它们完全隐形——
 * 骨架里没有，就不会被当成缺口。实测：210 个 `t()` 键在三语真相源里都不存在，
 * 而 `npm run check:locales` 报 **0 error**。
 *
 * 后果不是崩页：`intl-client-provider.tsx` 的 `getMessageFallback` 把缺 key
 * 兜底成**显示 key 路径**（有意为之的 fail-open）。所以它不报错、不进日志、
 * CI 全绿——用户看到的是 `ruleRegression.title` 这样的字符串。
 * **不报错的缺陷只能靠主动核对发现**，这就是本脚本的职责。
 *
 * <h3>用法</h3>
 *   node scripts/check-message-keys.mjs              # 报告 + 对照基线判定
 *   node scripts/check-message-keys.mjs --update     # 把当前缺失写成新基线
 *   node scripts/check-message-keys.mjs --list       # 打印全部缺失键（分批补文案用）
 *
 * <h3>基线机制</h3>
 * 存量 210 个缺失不阻塞（补文案是独立工作量），但**新增缺键必须报错**——
 * 否则边补边漏，永远收不了口。基线文件记录已知缺失键的**集合**；
 * 出现基线外的新键 → exit 1。基线里已修好的键会提示可以收窄。
 *
 * Exit codes:
 *   0 = 无基线外的新缺键
 *   1 = 出现新缺键（或真相源/基线文件读不到）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const BASELINE = join(__dirname, 'message-keys-baseline.json');

// 两个比对面，缺一不可：
//  · PACKAGE = 已安装的 npm 包 —— **生产实际能拿到的**。这里没有 = 用户看到 key 路径。
//  · SOURCE  = aster-lang-locales 的真相源（并列 checkout 时才有）。
// 二者的差集意义完全不同：
//  · 真相源有、包里没有 → **只是没发版**，不需要写文案，等发版列车即可
//  · 真相源也没有       → **真缺文案**，要去 aster-lang-locales 补
// 只比 npm 包会把「等发版」误报成「缺文案」，让人去重复写已经存在的键
//（实测 254 个缺失里有 97 个属于这类，其中 evidenceExport 34 键早在
//  2026-08-20 就进了真相源）。
const PACKAGE = join(PROJECT_ROOT, 'node_modules', '@aster-cloud/ui-messages', 'en-US.json');
const SOURCE = join(
  PROJECT_ROOT, '..', 'aster-lang-locales', 'locales', 'en',
  'src', 'main', 'resources', 'ui-messages', 'en-US.json',
);

const UPDATE = process.argv.includes('--update');
const LIST = process.argv.includes('--list');

/** 递归收集 src 下的 .ts/.tsx（排除测试与声明文件）。 */
function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 抽出一个文件里的 (namespace, key) 组合。
 *
 * ★按**变量名**绑定命名空间，而非「一个文件一个命名空间」：
 *     const t = useTranslations('settings.aiKeysPage');
 *     const tSettings = useTranslations('settings');
 * 这种双命名空间文件很常见（实测 31 个）。若整体跳过，会漏掉其中数百次
 * `t()` 调用；若强行归到第一个命名空间，又会产生**假缺失**（比漏报更糟：
 * 会让人去补根本不该存在的键）。按变量名绑定两者都避免。
 *
 * 无法归属的调用（如 `useTranslations()` 结果被解构或转手）计入 `unbound`
 * 并上报，让「查不了多少」显式可见，而不是悄悄少查。
 */
function extract(file) {
  // ★先剥注释：正则会匹配到注释里的 `t('settings')`（实测 teams/[teamId]/page.tsx
  //   有一句注释在解释历史修复，被误报成缺键）。误报比漏报更糟——它会让人去补
  //   一个根本不该存在的键。字符串字面量里的 `//` 不会被误剥，因为这里只在
  //   行首/代码位出现的注释起始处截断，且键名本身不含 `//`。
  const src = stripComments(readFileSync(file, 'utf-8'));

  // 变量名 → 命名空间
  const binding = new Map();
  for (const m of src.matchAll(
    /(?:const|let|var)\s+(\w+)\s*=\s*useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g,
  )) {
    binding.set(m[1], m[2]);
  }

  const keys = [];
  let unbound = 0;
  // 任意 `xxx('literal')` 里 xxx 是已绑定的 t-变量才算
  for (const m of src.matchAll(/\b(\w+)\(\s*['"]([A-Za-z][\w.]*)['"]/g)) {
    const [, fn, key] = m;
    if (binding.has(fn)) keys.push(`${binding.get(fn)}.${key}`);
  }
  // 有 useTranslations 但一个绑定都没解析出来 → 形态不认识，如实计数
  if (/useTranslations\(/.test(src) && binding.size === 0) unbound = 1;

  return { unbound, keys, hasT: binding.size > 0 };
}

/** 去掉 // 行注释与块注释，避免注释里的示例代码被当成真实调用。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/** 真相源里该路径是否是一个字符串叶子。 */
function hasLeaf(tree, path) {
  let cur = tree;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in cur)) return false;
    cur = cur[part];
  }
  return typeof cur === 'string';
}

if (!existsSync(PACKAGE)) {
  console.error(`✗ 找不到已安装的文案包: ${PACKAGE}\n  先跑 pnpm install。`);
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(PACKAGE, 'utf-8'));
// 真相源仅在并列 checkout 兄弟仓时可得（CI 的 aster-cloud job 不 checkout 它）。
// 缺失时退化为「只比 npm 包」，并显式说明——不静默少查。
const source = existsSync(SOURCE) ? JSON.parse(readFileSync(SOURCE, 'utf-8')) : null;

const missing = new Map(); // key -> Set<file>
let unboundFiles = 0;
let scanned = 0;

for (const file of sourceFiles(join(PROJECT_ROOT, 'src'))) {
  const { unbound, keys, hasT } = extract(file);
  unboundFiles += unbound;
  if (!hasT) continue;
  scanned++;
  for (const key of keys) {
    if (!hasLeaf(pkg, key)) {
      if (!missing.has(key)) missing.set(key, new Set());
      missing.get(key).add(relative(PROJECT_ROOT, file));
    }
  }
}

const found = [...missing.keys()].sort();

if (LIST) {
  for (const k of found) console.log(`${k}\t${[...missing.get(k)].join(',')}`);
  process.exit(0);
}

if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify({ missing: found }, null, 2) + '\n');
  console.log(`✓ 基线已更新: ${found.length} 个已知缺失键 → ${relative(PROJECT_ROOT, BASELINE)}`);
  process.exit(0);
}

const baseline = existsSync(BASELINE)
  ? new Set(JSON.parse(readFileSync(BASELINE, 'utf-8')).missing ?? [])
  : new Set();

const added = found.filter((k) => !baseline.has(k));
const fixed = [...baseline].filter((k) => !missing.has(k)).sort();

console.log(
  `扫描 ${scanned} 个含 useTranslations 的文件` +
    (unboundFiles > 0 ? `（${unboundFiles} 个无法解析绑定，未查）` : '（全部可解析绑定）'),
);
// 把缺失分成「等发版」与「真缺文案」——两者的处置完全不同。
const pendingRelease = source ? found.filter((k) => hasLeaf(source, k)) : [];
const trulyMissing = source ? found.filter((k) => !hasLeaf(source, k)) : found;
if (source) {
  console.log(
    `缺失键: ${found.length}（基线 ${baseline.size}）` +
      ` = 等发版 ${pendingRelease.length} + 真缺文案 ${trulyMissing.length}`,
  );
} else {
  console.log(
    `缺失键: ${found.length}（基线 ${baseline.size}）` +
      `\n  注：未并列 checkout aster-lang-locales，无法区分「等发版」与「真缺文案」。`,
  );
}

if (fixed.length > 0) {
  console.log(`\n✓ 已修复 ${fixed.length} 个（可跑 --update 收窄基线）:`);
  for (const k of fixed.slice(0, 10)) console.log(`    ${k}`);
  if (fixed.length > 10) console.log(`    … 另 ${fixed.length - 10} 个`);
}

if (added.length > 0) {
  console.error(`\n✗ 新增 ${added.length} 个基线外的缺失键——文案真相源里没有它们:`);
  for (const k of added) {
    console.error(`    ${k}`);
    for (const f of missing.get(k)) console.error(`        ${f}`);
  }
  const addedPending = source ? added.filter((k) => hasLeaf(source, k)) : [];
  if (addedPending.length > 0) {
    console.error(
      `\n  其中 ${addedPending.length} 个**真相源已有**，只是 npm 包未发版——` +
        `不要重复写文案，等发版列车即可。`,
    );
  }
  console.error(
    `\n  修法：在 aster-lang-locales 的三语 ui-messages 里补上这些键（真相源），\n` +
      `  再同步 aster-api 的 classpath 副本。切勿只加到 npm 包或 cloud 本地。\n` +
      `  若确属误报（如动态拼接的键），可跑 --update 但需在 PR 说明理由。`,
  );
  process.exit(1);
}

console.log('\n✓ 没有基线外的新缺失键');
