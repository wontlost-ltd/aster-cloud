import type { NextConfig } from "next";
import path from 'node:path';
import createNextIntlPlugin from 'next-intl/plugin';
import createMDX from '@next/mdx';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypePrettyCode from 'rehype-pretty-code';
import { rehypeSnippetMeta } from './src/lib/mdx/rehype-snippet-meta';
import { validateEnvOrWarn } from './src/lib/env-validation';
import { safeEnv } from './src/lib/runtime/safe-env';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// MDX pipeline — see .claude/plan/cloud-docs-subsite.md §3.2
// Pinned to @next/mdx@16.2.6 to match next@16.2.6. All remark/rehype
// plugins run at build-time only; nothing reaches the Worker runtime.
const withMDX = createMDX({
  extension: /\.mdx?$/,
  options: {
    remarkPlugins: [
      remarkFrontmatter,
      [remarkMdxFrontmatter, { name: 'frontmatter' }],
      remarkGfm,
    ],
    rehypePlugins: [
      rehypeSlug,
      [
        rehypePrettyCode,
        {
          // Dual-theme: client-side dark/light toggle via next-themes.
          // Shiki grammars compile at build-time; only HTML + tokens
          // reach the Worker bundle (no runtime highlighter).
          theme: { light: 'github-light', dark: 'github-dark' },
          keepBackground: false,
        },
      ],
      // Phase 3 — must run AFTER rehype-pretty-code so the `<pre>`
      // elements exist with their data-language / metastring attrs
      // for us to copy into snippet-specific data attrs.
      rehypeSnippetMeta,
      [
        rehypeAutolinkHeadings,
        { behavior: 'wrap', properties: { className: ['heading-anchor'] } },
      ],
    ],
  },
});

// 部署模式开关 — 见 src/lib/deployment-mode.ts + .claude/plan/deployment-mode-flag-v2.md
// next.config.ts 在 Node build-time 执行；但历史报错显示 OpenNext cold
// start 在 Worker bundle 加载阶段也会 touch 配置常量。统一走 safeEnv
// 避免任意 runtime 模块加载阶段 ReferenceError（P0-R9）。
const DEPLOYMENT_MODE: 'saas' | 'on-prem' =
  safeEnv('DEPLOYMENT_MODE') === 'on-prem' ? 'on-prem' : 'saas';

// 构建 SHA（进 sourceToolchainId 的 build= 段，供证据包溯源）。构建时从 CI 注入的 commit SHA 取，
// 缺省 'dev'。cloudToolchainId 运行时读 process.env.ASTER_RUNTIME_BUILD——这里 build 期 inline，
// 使部署后的 Worker 拿到真实 build SHA 而非 'dev'（证据溯源不再显示 build=dev）。
// 优先级：显式 ASTER_RUNTIME_BUILD > CF Workers Builds(WORKERS_CI_COMMIT_SHA) > CF_PAGES > GITHUB_SHA
// > git rev-parse（git checkout 里总能拿到）> 'dev'。取前 12 位短哈希。
function resolveRuntimeBuild(): string {
  const fromEnv =
    safeEnv('ASTER_RUNTIME_BUILD') ||
    safeEnv('WORKERS_CI_COMMIT_SHA') ||
    safeEnv('CF_PAGES_COMMIT_SHA') ||
    safeEnv('GITHUB_SHA');
  if (fromEnv) return fromEnv.slice(0, 12);
  // 兜底：build 在 git checkout 里跑，rev-parse 拿当前 commit（CI env 未注入 SHA 时也不退化成 dev）。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sha = require('node:child_process')
      .execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (sha) return sha.slice(0, 12);
  } catch {
    // 非 git 环境（如 vendored tarball）——落 'dev'。
  }
  return 'dev';
}
const RUNTIME_BUILD: string = resolveRuntimeBuild();

// 「关于」弹框要显示的三个版本。build 期从 package.json 读一次并 inline 进 bundle。
// ★不在运行时 import package.json：OpenNext 打包后该相对路径不可靠，且会把整个
//   依赖 manifest 拖进 bundle。这里读的是**实际锁定的依赖声明**，与 npm 上的
//   最新版无关——弹框要回答的是「这个部署在跑什么」，不是「生态最新是什么」。
const { APP_VERSION, ENGINE_VERSION, MESSAGES_VERSION } = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('./package.json') as {
      version?: string;
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};
    // 去掉 ^ ~ 等 range 前缀，只留数字版本（这两个依赖本就是精确 pin，防御性处理）。
    const exact = (v?: string) => (v ?? '').replace(/^[\^~>=<\s]+/, '') || 'unknown';
    return {
      APP_VERSION: pkg.version ?? 'unknown',
      ENGINE_VERSION: exact(deps['@aster-cloud/aster-lang-ts']),
      MESSAGES_VERSION: exact(deps['@aster-cloud/ui-messages']),
    };
  } catch {
    return { APP_VERSION: 'unknown', ENGINE_VERSION: 'unknown', MESSAGES_VERSION: 'unknown' };
  }
})();

// 只在 next build 阶段做一次 warn-only 校验。
//
// 历史踩坑：早先在这里无条件调 validateEnvOrWarn()，
// OpenNext on Cloudflare Workers 会在每个 cold start 重新加载这个模块，
// 而 Worker 的 secret binding 不通过 process.env 暴露 —— 导致 Worker 日志
// 每次冷启都喷一长串"缺失 DATABASE_URL/AUTH_SECRET/..."的 error，
// 看上去像 outage 实际只是 logger 误报（请求是能跑的）。
//
// 真正的 runtime fail-fast 在 src/instrumentation.ts，那里能正确识别
// Cloudflare 运行环境并降级为 warn。
if (safeEnv('NEXT_PHASE') === 'phase-production-build') {
  validateEnvOrWarn();
}

const nextConfig: NextConfig = {
  // Required for OpenNext Cloudflare deployment
  output: "standalone",
  // Fix workspace root detection for pnpm monorepo
  outputFileTracingRoot: __dirname,
  // Treat .mdx (and .md) as page files alongside .ts/.tsx.
  // Required so app/[locale]/docs/.../page.mdx is picked up.
  pageExtensions: ['ts', 'tsx', 'js', 'jsx', 'md', 'mdx'],
  // 仅 dev 生效：webpack dev 默认只缓冲最近 5 个按需编译的入口、闲置 60s 即释放，
  // 本地栈 E2E 预热的页面/路由会被后续编译挤掉并在用例中途重编译（冷启动超时）。
  // 放宽缓冲与闲置时长，让预热结果在整轮用例内保持有效；生产构建不读此项。
  onDemandEntries: {
    maxInactiveAge: 30 * 60 * 1000,
    pagesBufferLength: 100,
  },
  // Externalize heavy client-only packages to prevent bundling issues
  serverExternalPackages: [
    'monaco-editor',
    '@monaco-editor/react',
  ],
  // Security headers (CSP + HSTS + X-Frame-Options + etc.) are now set by
  // src/middleware.ts so we can attach a per-request CSP nonce. Keeping them
  // here too would emit duplicate response headers (and the runtime had been
  // observed to 500 with the duplicates). Leave this hook empty.

  // 把 build-time DEPLOYMENT_MODE 镜像给客户端 bundle —— useDeploymentMode()
  // 与 CLIENT_CAPABILITIES 读这个变量。webpack 会编译期 inline。
  env: {
    NEXT_PUBLIC_DEPLOYMENT_MODE: DEPLOYMENT_MODE,
    // build 期 inline 真实 build SHA → cloudToolchainId 读到它而非 'dev'（证据溯源用）。
    ASTER_RUNTIME_BUILD: RUNTIME_BUILD,
    // 「关于」弹框（用户菜单 → 帮助）展示用。build 期从 package.json 读并 inline——
    // 不在运行时 import package.json：OpenNext/Worker bundle 里该路径不可靠，
    // 且会把整个 manifest 打进 bundle。
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
    NEXT_PUBLIC_ENGINE_VERSION: ENGINE_VERSION,
    NEXT_PUBLIC_MESSAGES_VERSION: MESSAGES_VERSION,
  },

  webpack: (config, { webpack }) => {
    // 注入 __DEPLOYMENT_MODE__ ambient 字面量。
    // 配合 src/lib/deployment-mode.ts 的 `declare const __DEPLOYMENT_MODE__`，
    // 让 terser 看到 `if (literal)` 死分支并消除。
    //
    // 用 Next.js 传入的 webpack 实例避免顶部 import / 额外依赖。
    //
    // **Next 16 注意**：Next 16 默认 Turbopack，但 webpack hook 仍可用。
    // package.json 的 build / dev script 显式 `--webpack` 强制走 webpack 路径，
    // 否则这个 DefinePlugin 不会执行 → on-prem 模式下 SaaS-only npm 包
    // （stripe/resend/mixpanel-browser）不会被 dead-branch 消除，会泄露进 bundle。
    // 等 Turbopack 等价能力（define + alias=false）成熟后再迁移。
    config.plugins.push(
      new webpack.DefinePlugin({
        __DEPLOYMENT_MODE__: JSON.stringify(DEPLOYMENT_MODE),
      }),
    );

    // 双保险：on-prem 模式下硬阻断 SaaS-only npm 包。
    // spike report §3.2 实测：仅靠 IS_SAAS 死分支不能消除
    // `await import('stripe')` 表达式（webpack 把 dynamic import 视为
    // side-effectful），会把 128KB Stripe SDK chunk 打进 on-prem bundle。
    // alias = false 让 webpack 解析时直接找不到这些包，从根上排除。
    if (DEPLOYMENT_MODE === 'on-prem') {
      config.resolve = config.resolve || {};
      // J3: telemetry envelope module reads ASTER_TELEMETRY_SECRET_KEK,
      // which is a SaaS-only secret. The IS_SAAS runtime guard alone
      // leaves the env literal in dead branches that webpack DCE can't
      // fold. Aliasing the three modules to `false` makes webpack
      // resolve them to an empty module → env literal absent from bundle.
      //
      // These modules are only imported by SaaS-only route files
      // (api/v1/telemetry, stripe webhook → renewal handler), and the
      // route files themselves return 404 in on-prem at runtime, so the
      // alias is safe — nothing in on-prem actually calls the symbols.
      const srcDir = path.resolve(__dirname, 'src');
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        stripe: false,
        resend: false,
        'mixpanel-browser': false,
        // J3: alias on the resolved absolute path — `@/` is a tsconfig
        // alias that webpack resolves via tsconfig-paths *before*
        // consulting resolve.alias, so the `@/`-keyed entries below
        // never match. Anchor by the file system path instead.
        [path.join(srcDir, 'lib/telemetry/envelope')]: false,
        [path.join(srcDir, 'lib/telemetry/secret-store')]: false,
        [path.join(srcDir, 'lib/telemetry/issuance')]: false,
      };
    }
    return config;
  },
};

// Plugin composition order:
//   nextConfig → withMDX (adds .mdx loader + handles MDX compile)
//              → withNextIntl (i18n routing wrapper, must be outermost
//                so it sees the final config including MDX page extensions)
export default withNextIntl(withMDX(nextConfig));
