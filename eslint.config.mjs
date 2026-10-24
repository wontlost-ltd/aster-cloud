import { globalIgnores } from "eslint/config";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";
import deploymentModePlugin from "./eslint-rules/index.js";

const eslintConfig = [
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    ".open-next/**",
    "next-env.d.ts",
  ]),
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react": reactPlugin,
      "react-hooks": reactHooksPlugin,
      "@next/next": nextPlugin,
      "deployment-mode": deploymentModePlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs["jsx-runtime"].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // Next.js 默认行为：允许 _ 前缀的未使用变量
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      // R8-FE-1：禁止生产代码从 lib/__internal__/* 导入 —— 那是测试夹具专区。
      // 测试文件 (__tests__) 通过下面的 override 放行。
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["**/lib/__internal__/*", "@/lib/__internal__/*"],
            message:
              "lib/__internal__/* 仅供测试导入。生产代码请使用 lexicon-availability 公开 API。",
          },
        ],
      }],
      // PR-9: 守门 deployment-mode 直接 macro / process.env 访问。
      // 详见 eslint-rules/no-direct-macro.js + .claude/plan/deployment-mode-flag-v2.md。
      "deployment-mode/no-direct-macro": "error",
      // PR-license-v2: admin mutate routes 必须调用 requireLicenseWriteOk()
      // 或显式守门 !IS_SAAS（SaaS-only endpoint）。
      // 详见 eslint-rules/require-license-write-gate.js。
      "deployment-mode/require-license-write-gate": "error",
      // Turbopack-compat: 禁止静态 value-import SaaS-only npm 包。
      // 必须走 @/lib/{stripe,resend,mixpanel} wrapper，里面 `await import()`
      // 配合 __DEPLOYMENT_MODE__ 守门让 terser 折叠死分支。
      // 这条规则替代 webpack 的 resolve.alias = false（Turbopack 没有等价能力）。
      // 详见 eslint-rules/no-static-saas-only-import.js。
      "deployment-mode/no-static-saas-only-import": "error",
      // R32 hotfix follow-up：守门 Drizzle 关系查询 orderBy 不能引用
      // 非 root 表的列。源由 c6f8f5a：api/teams GET 500 事件。规则
      // 详见 eslint-rules/no-cross-table-orderby.js。
      "deployment-mode/no-cross-table-orderby": "error",
      "deployment-mode/no-stale-safe-column-read": "error",
    },
  },
  {
    // 测试文件可自由 import __internal__ 测试助手
    files: [
      "src/__tests__/**/*.{ts,tsx}",
      "**/*.test.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": "off",
      // 测试需要直接 stub process.env.DEPLOYMENT_MODE 验证模式切换；
      // 这是测试的合法用途。生产代码仍受规则约束。
      "deployment-mode/no-direct-macro": "off",
      "deployment-mode/require-license-write-gate": "off",
      // 测试可能需要 mock 整个 stripe/resend SDK；放开。
      "deployment-mode/no-static-saas-only-import": "off",
    },
  },
];

export default eslintConfig;
