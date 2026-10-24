'use strict';

const fs = require('node:fs');
const path = require('node:path');

function collectSourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(file);
    return /\.[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [file] : [];
  });
}

function hasStaleCalls(registrySource, sourceFiles) {
  if (!/SAFE_COLUMNS\s*:[^=]+\=\s*\[\s*\]/s.test(registrySource)) return false;
  return sourceFiles.some((entry) => {
    const file = typeof entry === 'string' ? entry : entry.path;
    const content = typeof entry === 'string' ? fs.readFileSync(file, 'utf8') : entry.content;
    return !file.includes(`${path.sep}__tests__${path.sep}`) && /\bsafeColumnRead\s*\(/.test(content);
  });
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'SAFE_COLUMNS 清空后禁止遗留 safeColumnRead 调用' },
    messages: { staleCall: 'SAFE_COLUMNS 已为空，必须删除仓内 safeColumnRead 调用。' },
    schema: [],
  },
  create(context) {
    const root = process.cwd();
    const registry = path.join(root, 'src/lib/safe-column-read.ts');
    const current = path.resolve(context.filename ?? context.getFilename());
    if (current !== registry || !fs.existsSync(registry)) return {};

    const source = fs.readFileSync(registry, 'utf8');
    const files = collectSourceFiles(path.join(root, 'src'));
    if (!hasStaleCalls(source, files)) return {};

    return {
      Program(node) {
        context.report({ node, messageId: 'staleCall' });
      },
    };
  },
};

module.exports = rule;
module.exports.hasStaleCalls = hasStaleCalls;
