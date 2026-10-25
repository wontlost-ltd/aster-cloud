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

import { readFileSync, writeFileSync, existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
// ★第三个来源：cloud 本地补充层（src/i18n/demo-supplement.ts）。
// request.ts 用 deepMergeMessages 把它**叠在 npm 包之上**，所以这里的 key
// 在运行时同样有效。不读它会把 demo 页 / 团队语言卡等一大批键误报成缺失——
// 而它们本就**有意**不进共享包（见该文件头注释：避免胖化共享包与跨仓发版耦合）。
const SUPPLEMENT = join(PROJECT_ROOT, 'src', 'i18n', 'demo-supplement.ts');

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

function extract(file) {
  return extractFromSource(readFileSync(file, 'utf-8'));
}

/**
 * 解析 `useTranslations(…)` / `getTranslations(…)` 的参数得到命名空间。
 *   ()                                  → ''（根命名空间，键即完整路径）
 *   ('ns')                              → 'ns'
 *   ({ locale, namespace: 'ns' })       → 'ns'
 *   ({ locale })                        → ''
 * 其余形态（变量、模板字符串）返回 null：无法静态确定，宁可不查。
 */
function parseNamespaceArg(args) {
  const a = args.trim();
  if (a === '') return '';
  const literal = a.match(/^['"]([^'"]+)['"]$/);
  if (literal) return literal[1];
  if (a.startsWith('{') && a.endsWith('}')) {
    const ns = a.match(/\bnamespace\s*:\s*['"]([^'"]+)['"]/);
    if (ns) return ns[1];
    return /\bnamespace\b/.test(a) ? null : '';
  }
  return null;
}

/**
 * 从源码文本抽出 (namespace, key) 组合；纯函数，供测试直接调用。
 *
 * ★按**变量名**绑定命名空间，而非「一个文件一个命名空间」：
 *     const t = useTranslations('settings.aiKeysPage');
 *     const tSettings = useTranslations('settings');
 * 服务端组件的 `await getTranslations('ns')` / `getTranslations({ locale, namespace })`
 * 与无参 `useTranslations()`（根命名空间，键写完整路径）同样纳入——此前三者都被跳过，
 * 整类页面（服务端页、docs 组件）的键从未被核对。
 *
 * ★同一文件里**同名变量绑不同命名空间**是真实存在的：
 *     export function A() { const t = useTranslations('admin.riskTier'); … }
 *     function B()        { const t = useTranslations('admin.riskTier.override'); … }
 *   正则无作用域概念。处置：每个调用归属到**它之前最近的一次同名声明**——
 *   组件按顺序书写时这正是其所在作用域的绑定。调用出现在该名任何声明之前
 *   （例如提升的辅助函数）且该名绑定不唯一时，无法判定 → 不查并计入 unbound。
 *
 * 无法归属的调用（如 `useTranslations()` 结果被解构或转手）计入 `unbound`
 * 并上报，让「查不了多少」显式可见，而不是悄悄少查。
 */
export function extractFromSource(raw) {
  // ★先剥注释：正则会匹配到注释里的 `t('settings')`（实测 teams/[teamId]/page.tsx
  //   有一句注释在解释历史修复，被误报成缺键）。误报比漏报更糟——它会让人去补
  //   一个根本不该存在的键。
  const src = stripComments(raw);

  // 变量名 → 按出现位置排序的声明列表 [{ index, ns }]
  const decls = new Map();
  let unresolvedDecl = false;
  for (const m of src.matchAll(
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(([^)]*)\)/g,
  )) {
    const ns = parseNamespaceArg(m[2]);
    if (ns === null) { unresolvedDecl = true; continue; }
    if (!decls.has(m[1])) decls.set(m[1], []);
    decls.get(m[1]).push({ index: m.index, ns });
  }

  // 调用位置 → 命名空间；undefined 表示该名不是 t-变量，null 表示是但无法判定。
  const resolve = (fn, index) => {
    const list = decls.get(fn);
    if (!list) return undefined;
    let hit = null;
    for (const d of list) if (d.index < index) hit = d;
    if (hit) return hit.ns;
    return new Set(list.map((d) => d.ns)).size === 1 ? list[0].ns : null;
  };

  const keys = [];
  let unresolvedCall = false;
  // 任意 `xxx('literal')` 里 xxx 是已绑定的 t-变量才算；排除 `obj.t(` 这类成员调用。
  for (const m of src.matchAll(/(?<![.\w$])(\w+)\(\s*['"]([A-Za-z][\w.]*)['"]/g)) {
    const ns = resolve(m[1], m.index);
    if (ns === undefined) continue;
    if (ns === null) { unresolvedCall = true; continue; }
    keys.push(joinKey(ns, m[2]));
  }
  const dynamicPrefixes = extractDynamicPrefixes(src, resolve);

  const usesTranslations = /\b(?:useTranslations|getTranslations)\(/.test(src);
  const unbound = usesTranslations && (decls.size === 0 || unresolvedDecl || unresolvedCall) ? 1 : 0;
  return { unbound, keys, dynamicPrefixes, hasT: decls.size > 0 };
}

/** 命名空间与相对键拼成完整路径；根命名空间时键本身即完整路径。 */
function joinKey(ns, key) {
  return ns ? `${ns}.${key}` : key;
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

/** 动态键前缀必须指向消息树中的对象节点。 */
export function hasPath(tree, path) {
  let cur = tree;
  for (const part of path.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in cur)) return false;
    cur = cur[part];
  }
  return typeof cur === 'object' && cur !== null;
}

/**
 * 收集 t(`静态前缀.${变量}`) 的前缀完整路径。
 * `binding` 可以是「变量名 → 命名空间」的 Map，也可以是 `(fn, index) => ns` 解析函数
 * （按调用位置取最近声明，见 extractFromSource）。
 */
export function extractDynamicPrefixes(src, binding) {
  const resolve = typeof binding === 'function' ? binding : (fn) => binding.get(fn);
  const prefixes = [];
  for (const match of src.matchAll(/(?<![.\w$])(\w+)\(\s*`([A-Za-z][\w.]*)\.\$\{/g)) {
    const [, fn, prefix] = match;
    const ns = resolve(fn, match.index);
    if (ns !== undefined && ns !== null) prefixes.push(joinKey(ns, prefix));
  }
  return prefixes;
}

/** 从 `start`（开引号位置）跳到匹配的未转义闭引号之后；未闭合则返回文本末尾。 */
function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

/**
 * 展开单行内联对象 `{ a: 'x', b: { c: "y" } }` 的叶子键路径。
 *
 * 逐字符扫描：字符串字面量整体跳过（值里的 `{`、`,`、`:` 不参与结构判定），
 * `name: {` 入栈，`}` 出栈，`name: '值'` 记为叶子。
 */
function collectInlineKeys(text, base, out, includeObjectNodes = false) {
  const path = [...base];
  const opened = [];
  let i = text.indexOf('{') + 1;
  while (i < text.length) {
    const rest = text.slice(i);
    const obj = rest.match(/^\s*,?\s*([A-Za-z_]\w*)\s*:\s*\{/);
    const leaf = rest.match(/^\s*,?\s*([A-Za-z_]\w*)\s*:\s*(['"`])/);
    if (obj) {
      opened.push(obj[1]);
      path.push(obj[1]);
      // 记录对象节点本身，供模板字符串的动态子键前缀做存在性校验。
      if (includeObjectNodes) out.add(`${path.join('.')}.__object__`);
      i += obj[0].length;
    } else if (leaf) {
      out.add([...path, leaf[1]].join('.'));
      i = skipString(text, i + leaf[0].length - 1);
    } else if (/^\s*\}/.test(rest)) {
      if (opened.length) { opened.pop(); path.pop(); }
      i += rest.indexOf('}') + 1;
    } else if (/['"`]/.test(text[i])) {
      // 非字面量值（三元、数组、调用）里的字符串也整体跳过，避免其中的 `word: 'x'` 被当成键。
      i = skipString(text, i);
    } else {
      i++;
    }
  }
}

/**
 * 从 demo-supplement.ts 里取 `en` 子树的**键路径集合**。
 *
 * 不求值 TS、也不解析成对象——只需要「这个路径存在吗」。用括号配平找到
 * `en: {` 的范围，再按 `key:` 的缩进层级还原路径。值是什么无关紧要。
 */
export function parseSupplementKeys(src, includeObjectNodes = false) {
  const start = src.indexOf('\n  en: {');
  if (start < 0) return new Set();
  let depth = 0;
  let end = start;
  // 配平时跳过字符串与 // 注释：值里不成对的 `{` / `}` 不应改变深度。
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') i = skipString(src, i) - 1;
    else if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
    }
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = src.slice(start, end);
  const out = new Set();
  const stack = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '');
    const indent = line.search(/\S/);
    if (indent < 0) continue;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const open = line.match(/^\s*([A-Za-z_]\w*)\s*:\s*\{\s*$/);
    if (open) { stack.push({ indent, name: open[1] }); continue; }
    // 单行内联对象 `key: { a: 'x', b: { c: "y" } },`：在同一行内闭合，不入栈。
    const inline = line.match(/^\s*([A-Za-z_]\w*)\s*:\s*(\{.*\})\s*,?\s*$/);
    if (inline) {
      const base = [...stack.slice(1).map((f) => f.name), inline[1]];
      collectInlineKeys(inline[2], base, out, includeObjectNodes);
      continue;
    }
    // ★值可能被 prettier 折到下一行：
    //     emptyHint:
    //       'Skeletons are captured when…',
    //   故 `key:` 后面允许行尾没有引号——只要它不是开一个新对象（上面已处理）
    //   或数组，就当作叶子。漏掉这种形态会让 5 个**实际存在**的键被误报成缺失。
    const leaf = line.match(/^\s*([A-Za-z_]\w*)\s*:\s*(['"`]|$)/);
    if (leaf) {
      const path = [...stack.slice(1).map((f) => f.name), leaf[1]].join('.');
      if (path) out.add(path);
    }
  }
  return out;
}
/**
 * 扫描 `src/` 全部源文件，返回不存在于「npm 包 ∪ cloud 本地补充层」的键。
 * CLI 与单元测试共用这一份逻辑（测试直接断言 missing 为空）。
 *
 * @returns {{ missing: Map<string, Set<string>>, scanned: number, unboundFiles: number,
 *             pkg: object, source: object | null }}
 */
export function scanMissingKeys() {
  if (!existsSync(PACKAGE)) {
    throw new Error(`找不到已安装的文案包: ${PACKAGE}（先跑 pnpm install）`);
  }
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf-8'));
  // 真相源仅在并列 checkout 兄弟仓时可得（CI 的 aster-cloud job 不 checkout 它）。
  // 缺失时退化为「只比 npm 包」，并显式说明——不静默少查。
  const source = existsSync(SOURCE) ? JSON.parse(readFileSync(SOURCE, 'utf-8')) : null;

  const supplement = existsSync(SUPPLEMENT)
    ? parseSupplementKeys(readFileSync(SUPPLEMENT, 'utf-8'), true)
    : new Set();

  const missing = new Map(); // key -> Set<file>
  let unboundFiles = 0;
  let scanned = 0;
  const dynamicMissing = new Map();

  for (const file of sourceFiles(join(PROJECT_ROOT, 'src'))) {
    const { unbound, keys, dynamicPrefixes, hasT } = extract(file);
    unboundFiles += unbound;
    if (!hasT) continue;
    scanned++;
    for (const key of keys) {
      if (!hasLeaf(pkg, key) && !supplement.has(key)) {
        if (!missing.has(key)) missing.set(key, new Set());
        missing.get(key).add(relative(PROJECT_ROOT, file));
      }
    }
    for (const prefix of dynamicPrefixes) {
      const packagePath = hasPath(pkg, prefix);
      const sourcePath = source && hasPath(source, prefix);
      const supplementPath = [...supplement].some((key) => key === `${prefix}.__object__` || key.startsWith(`${prefix}.`));
      if (!packagePath && !sourcePath && !supplementPath) {
        if (!dynamicMissing.has(`${prefix}.*`)) dynamicMissing.set(`${prefix}.*`, new Set());
        dynamicMissing.get(`${prefix}.*`).add(relative(PROJECT_ROOT, file));
      }
    }
  }

  for (const [key, files] of dynamicMissing) missing.set(key, files);
  return { missing, scanned, unboundFiles, pkg, source };
}

function main() {
  let result;
  try {
    result = scanMissingKeys();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
  const { missing, scanned, unboundFiles, source } = result;

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
    `扫描 ${scanned} 个含 useTranslations/getTranslations 的文件` +
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
}

// 仅作为 CLI 直接运行时执行；被测试 import 时不产生副作用。
// Node 会解析 import.meta.url 的符号链接但不解析 argv[1]，经软链接检出运行时
// 若直接比较会永远不相等、main() 不执行、门禁静默 exit 0（失败开放），故先 realpath。
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
