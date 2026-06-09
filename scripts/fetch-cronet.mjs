#!/usr/bin/env node
/**
 * fetch-cronet.mjs — 下载各平台 NaiveProxy 核心库 libcronet 到 resources/{平台}/，
 * 供 electron-builder 的 extraResources(`**​/*` filter) 随安装包打包（与 sing-box 二进制同模式）。
 *
 * 用法：node scripts/fetch-cronet.mjs [--force]
 *
 * ⚠️ macOS 不在此脚本范围：cronet 在 mac 上不走动态库。FlowZ 的 mac-arm64 sing-box 二进制已把 cronet
 *   静态编入（CGO，实测二进制内含 cronet 符号、无 dlopen libcronet.dylib），naive 开箱即用、无需任何
 *   外部库。mac-x64 二进制未编入 cronet → naive 暂不可用（需重编带 naive 的 x64 核心）。详见 README。
 *
 * ⚠️ 版本耦合：cronetVersion（src/shared/core-manifest.json）应与「随 app 打包的 sing-box 所用
 *   cronet-go 版本」对应。cronet 走 C API（Chromium 稳定 ABI），跨 sing-box 小版本一般兼容；若升级
 *   sing-box 后 naive 报符号错，提高 manifest 中的版本并重打包。该 manifest 同时被 TS 主进程读取，
 *   是核心/cronet 版本耦合的唯一真源。来源：https://github.com/SagerNet/cronet-go/releases
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'fs';
import { get } from 'https';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 版本耦合的唯一真源：与 TS 主进程共享同一份 manifest，升级核心只需改 core-manifest.json。
const coreManifest = JSON.parse(
  readFileSync(join(ROOT, 'src/shared/core-manifest.json'), 'utf-8')
);
const CRONET_VERSION = coreManifest.cronetVersion; // ← 与打包 sing-box 的 cronet-go 版本对齐
const REPO = 'SagerNet/cronet-go';
const FORCE = process.argv.includes('--force');

// 仅 linux/windows 走动态库；mac 静态编入核心二进制，不需下载（见文件头）。
// resources 目标目录 ← cronet-go 资产名 → 落地文件名(purego 期望)
const TARGETS = [
  { dir: 'resources/linux', asset: 'libcronet-linux-amd64.so', out: 'libcronet.so' },
  { dir: 'resources/win', asset: 'libcronet-windows-amd64.dll', out: 'libcronet.dll' },
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
      // 原子写：先写 .tmp，完成再 rename；失败/中断则删 .tmp，避免把截断文件当成"已存在"误用
      const tmp = `${dest}.tmp`;
      const file = createWriteStream(tmp);
      const fail = (e) => {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        reject(e);
      };
      res.on('error', fail);
      file.on('error', fail);
      res.pipe(file);
      file.on('finish', () =>
        file.close((err) => {
          if (err) return fail(err);
          try {
            renameSync(tmp, dest);
            resolve();
          } catch (e) {
            fail(e);
          }
        })
      );
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
console.log('macOS: cronet 静态编入 mac-arm64 核心，无需下载（见脚本头注）。');
process.exit(failed > 0 ? 1 : 0);
