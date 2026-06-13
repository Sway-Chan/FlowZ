#!/usr/bin/env node
/**
 * 构建时注入真实构建日期（B-1）。
 *
 * 原状：version-handlers 运行时 new Date().toISOString().split('T')[0] → 每次打开 about 页显示「今天」，
 * 非真实构建日期，版本诊断/报 bug 定位构建版本的价值归零。
 *
 * 方案：每次构建主进程前生成 src/shared/build-info.ts（含构建时刻日期常量），主进程 import。
 * 该文件不入库（.gitignore），由本脚本在 build:main / dev:main / dev 前置步骤生成；
 * 既有调用点（build/dev/package）均已前置 node scripts/gen-build-info.js，故文件恒存在。
 */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'src', 'shared', 'build-info.ts');
const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD（UTC，构建服务器时区无关）

const content = `// 自动生成，勿手改（scripts/gen-build-info.js）。不入库（.gitignore）。
export const BUILD_DATE = '${today}';
`;

fs.writeFileSync(target, content, 'utf-8');
console.log(`[build-info] 写入 ${path.relative(process.cwd(), target)} → BUILD_DATE=${today}`);
