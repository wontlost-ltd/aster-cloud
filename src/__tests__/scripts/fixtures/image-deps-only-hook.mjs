/**
 * 模拟 resolver 迁移镜像的依赖集合（#853）：仓库源码（非 node_modules）里导入的裸包名，
 * 只要不在 IMAGE_DEPENDENCIES（JSON 数组，取自 Dockerfile.resolver-migration 的运行时清单）里，
 * 就按镜像里的真实报错抛 ERR_MODULE_NOT_FOUND。node_modules 内部的传递依赖照常解析。
 *
 * 用法：node --conditions=import --import <本文件> --import tsx scripts/resolver-migration.ts --help
 * 本钩子先注册，tsx 后注册、先执行：@/ 别名由 tsx 改写成文件路径后才到这里，这里只看到裸包名。
 */
import { isBuiltin, registerHooks } from 'node:module';

const allowed = new Set(JSON.parse(process.env.IMAGE_DEPENDENCIES ?? '[]'));

function packageName(specifier) {
  if (/^(\.|\/|[a-z]+:|@\/|#)/i.test(specifier) || isBuiltin(specifier)) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = packageName(specifier);
    const fromSource = context.parentURL?.startsWith('file:') && !context.parentURL.includes('/node_modules/');
    if (name && fromSource && !allowed.has(name)) {
      const error = new Error(`Cannot find package '${name}' imported from ${context.parentURL}`);
      error.code = 'ERR_MODULE_NOT_FOUND';
      throw error;
    }
    return nextResolve(specifier, context);
  },
});
