#!/usr/bin/env node
/**
 * fetch-cronet.mjs — 下载各平台 NaiveProxy 核心库 libcronet 到 resources/{平台}/，
 * 供 electron-builder 的 extraResources(`**​/*` filter) 随安装包打包（与 sing-box 二进制同模式）。
 *
 * 用法：node scripts/fetch-cronet.mjs [--force]
 *
 * ⚠️ macOS：SagerNet/cronet-go 不分发预编译 libcronet.dylib（release 只有 linux/windows）。mac 下
 *   naive 需自行用 cronet-go 的 build-naive 从源码构建 libcronet.dylib 放进 resources/mac-{arch}/，
 *   否则运行时 hasCronetLib()=false、naive 节点会被优雅跳过（不影响其它协议节点）。
 *
 * ⚠️ 版本耦合：CRONET_VERSION 应与「随 app 打包的 sing-box 所用 cronet-go 版本」对应。cronet 走
 *   C API（Chromium 稳定 ABI），跨 sing-box 小版本一般兼容；若升级 sing-box 后 naive 报符号错，提高
 *   此处版本并重打包。来源：https://github.com/SagerNet/cronet-go/releases
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { get } from 'https';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const CRONET_VERSION = 'v148.0.7778.96-1'; // ← 与打包 sing-box 的 cronet-go 版本对齐
const REPO = 'SagerNet/cronet-go';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');

// 仅 linux/windows 有官方预编译资产；mac 见文件头说明（build-from-source）。
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
console.log('macOS: 需自行从源码构建 libcronet.dylib（见脚本头注），否则 mac 下 naive 节点将被跳过。');
process.exit(failed > 0 ? 1 : 0);
