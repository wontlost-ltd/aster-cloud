/**
 * 让 node-postgres 在 `node --conditions=import` 下可加载（#842）。
 *
 * 运维脚本（ops:resolver-migration、seed:credit-pilot、seed:agent-guard-demo，以及 k3s resolver-migration
 * CronJob）用 `--conditions=import` 启动：引擎包 aster-lang-ts 的 ./browser 导出只声明了 import 条件。
 * 但这个开关对 require() 同样生效：pg/lib/index.js 里的 `require('pg-pool')` 会命中 pg-pool 导出表中
 * 排在前面的 "import" 分支（ESM 包装，只有 default 导出），拿到的是模块命名空间对象，
 * `class BoundPool extends Pool` 随即抛 "Class extends value #<Object> is not a constructor"。
 *
 * 修法：注册一个同步解析钩子，只对 require('pg-pool') 去掉 import 条件，让它解析到 CJS 入口；
 * 其余模块（包括引擎包）的解析不受影响，启动命令也不用改。
 *
 * 必须在任何会加载 pg 的模块之前导入（脚本的第一条 import）。只在 Node 进程里使用，不进 Worker 包。
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'pg-pool' && context.conditions?.includes('require')) {
      return nextResolve(specifier, {
        ...context,
        conditions: context.conditions.filter((c) => c !== 'import'),
      });
    }
    return nextResolve(specifier, context);
  },
});
