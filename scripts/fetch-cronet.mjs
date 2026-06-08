#!/usr/bin/env node
/**
 * fetch-cronet.mjs — 下载各平台 NaiveProxy 核心库 libcronet 到 resources/{平台}/，
 * 供 electron-builder 的 extraResources(`**​/*` filter) 随安装包打包（与 sing-box 二进制同模式）。
 *
 * 用法：node scripts/fetch-cronet.mjs [--force]
 *
 * ⚠️ 版本耦合：CRONET_VERSION 应与「随 app 打包的 sing-box 所用 cronet-go 版本」对应。
 *   cronet 走 C API（Chromium 稳定 ABI），跨 sing-box 小版本一般兼容；若升级 sing-box 后 naive 报
 *   符号错，提高此处版本并重打包。来源：https://github.com/SagerNet/cronet-go/releases
 */
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { get } from 'https';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const CRONET_VERSION = 'v148.0.7778.96-1'; // ← 与打包 sing-box 的 cronet-go 版本对齐
const REPO = 'SagerNet/cronet-go';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');

// resources 目标目录 ← cronet-go 资产名 → 落地文件名(purego 期望)
const TARGETS = [
  { dir: 'resources/linux', asset: 'libcronet-linux-amd64.so', out: 'libcronet.so' },
  { dir: 'resources/win', asset: 'libcronet-windows-amd64.dll', out: 'libcronet.dll' },
  { dir: 'resources/mac-arm64', asset: 'libcronet-darwin-arm64.dylib', out: 'libcronet.dylib' },
  { dir: 'resources/mac-x64', asset: 'libcronet-darwin-amd64.dylib', out: 'libcronet.dylib' },
];

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    get(url, { headers: { 'User-Agent': 'FlowZ-fetch-cronet' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    }).on('error', reject);
  });
}

let ok = 0;
let failed = 0;
for (const t of TARGETS) {
  const absDir = join(ROOT, t.dir);
  const dest = join(absDir, t.out);
  if (existsSync(dest) && !FORCE) {
    console.log(`skip (exists): ${t.dir}/${t.out}`);
    ok++;
    continue;
  }
  mkdirSync(absDir, { recursive: true });
  const url = `https://github.com/${REPO}/releases/download/${CRONET_VERSION}/${t.asset}`;
  try {
    console.log(`downloading ${t.asset} → ${t.dir}/${t.out} ...`);
    await download(url, dest);
    console.log(`  ok`);
    ok++;
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    failed++;
  }
}
console.log(`\ncronet libs: ${ok} ready, ${failed} failed (version ${CRONET_VERSION}).`);
process.exit(failed > 0 ? 1 : 0);
