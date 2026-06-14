/**
 * 内置 geo 规则集（geosite-cn / geosite-geolocation-!cn / geoip-cn）的单一真值表。
 *
 * 这三件套随 app 分发（resources/data → process.resourcesPath/data，见 electron-builder.json），
 * 智能分流/全局模式的本地 rule_set（type:local）引用它们，路由生成与拷贝落地共用本表，杜绝目录/文件名漂移。
 *
 * 运行时文件落 <userData>/rules/<tag>.srs（与「规则资源」页用户下载的 <userData>/rule-resources/ 分目录）。
 * - 出厂源 bundledPath()：seed-if-missing 与「重置为出厂」用。
 * - 网络更新源 sourceUrl：SagerNet rule-set 分支（与出厂数据同源，零漂移），走 RuleResourceManager 的 gh-proxy 重试链。
 *
 * 不再「每次启动无条件覆盖」——改 seed-if-missing-or-invalid（见 seedBuiltinRuleSets），
 * 否则网络更新成功的新版本会在下次启动被出厂版静默回滚。
 */
import * as path from 'path';
import * as fssync from 'fs';
import * as fsp from 'fs/promises';
import { getUserDataPath } from '../utils/paths';
import { resourceManager } from './ResourceManager';
import type { RuleResourceCategory } from '../../shared/types';

export const BUILTIN_ID_PREFIX = 'builtin:';

export interface BuiltinGeoRuleSet {
  /** sing-box rule_set tag，同时是运行时文件名前缀。 */
  tag: string;
  /** 运行时落盘名 `${tag}.srs`。 */
  fileName: string;
  category: RuleResourceCategory;
  /** 出厂源（resources/data 内随包分发），seed / reset 用。 */
  bundledPath: () => string;
  /** 网络更新源（SagerNet rule-set raw，复用下载层 gh-proxy 重试链）。 */
  sourceUrl: string;
}

export const BUILTIN_GEO_RULESETS: BuiltinGeoRuleSet[] = [
  {
    tag: 'geosite-cn',
    fileName: 'geosite-cn.srs',
    category: 'geosite',
    bundledPath: () => resourceManager.getGeoSiteCNPath(),
    sourceUrl: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
  },
  {
    tag: 'geosite-geolocation-!cn',
    fileName: 'geosite-geolocation-!cn.srs',
    category: 'geosite',
    bundledPath: () => resourceManager.getGeoSiteNonCNPath(),
    sourceUrl:
      'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-!cn.srs',
  },
  {
    tag: 'geoip-cn',
    fileName: 'geoip-cn.srs',
    category: 'geoip',
    bundledPath: () => resourceManager.getGeoIPPath(),
    sourceUrl: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs',
  },
];

/** 本地 geo 规则集运行时目录（内置 .srs 拷贝落地处）。copy 与 route 生成共用，单一真值。 */
export function getRuleSetRuntimeDir(): string {
  return path.join(getUserDataPath(), 'rules');
}

export const isBuiltinId = (id: string): boolean => id.startsWith(BUILTIN_ID_PREFIX);
export const builtinIdFor = (tag: string): string => `${BUILTIN_ID_PREFIX}${tag}`;
export const builtinTagFromId = (id: string): string => id.slice(BUILTIN_ID_PREFIX.length);
export const findBuiltin = (tag: string): BuiltinGeoRuleSet | undefined =>
  BUILTIN_GEO_RULESETS.find((b) => b.tag === tag);

/** SRS 文件魔数校验（'SRS' = 0x53 0x52 0x53），拦半写/损坏文件。同步读前 3 字节。 */
export function isValidSrsFile(p: string): boolean {
  let fd: number | null = null;
  try {
    fd = fssync.openSync(p, 'r');
    const buf = Buffer.alloc(3);
    const n = fssync.readSync(fd, buf, 0, 3, 0);
    return n === 3 && buf[0] === 0x53 && buf[1] === 0x52 && buf[2] === 0x53;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fssync.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

let seedCounter = 0;

/**
 * 内置 geo 规则集落地（原子 tmp→rename，防 TUN 特权进程读半写文件；单项失败不抛、不阻断其余项；幂等）：
 * - **缺失/损坏必种**（seed-if-missing-or-invalid）。
 * - `refreshOutOfBox`（仅启动时传）：**出厂态**（无网络更新记录 = `builtinGeoMeta[tag].updatedAt` 缺失）下，
 *   若 bundled 与 runtime 文件大小不一致（=app 升级带来新出厂数据）→ 刷新为新出厂版。
 *   **已网络更新的文件永不被覆盖**（有 updatedAt 即不在刷新范围）。仅启动时启用——此刻无并发 updateBuiltin，
 *   刷新落地无竞态；运行中（代理启动）的补种只做「缺失补种」，不与并发更新争抢。
 *
 * 这同时修复「seed-if-missing 后出厂态用户跨 app 升级冻结在首装版」的回归（旧逻辑每次启动无条件覆盖）。
 */
export async function seedBuiltinRuleSets(opts?: {
  builtinGeoMeta?: Record<string, { updatedAt?: string }>;
  refreshOutOfBox?: boolean;
}): Promise<void> {
  const runtimeDir = getRuleSetRuntimeDir();
  for (const b of BUILTIN_GEO_RULESETS) {
    const dest = path.join(runtimeDir, b.fileName);
    const src = b.bundledPath();
    const outOfBox = !opts?.builtinGeoMeta?.[b.tag]?.updatedAt;
    let reason: 'missing' | 'refresh' | null = null;
    if (!isValidSrsFile(dest)) reason = 'missing';
    else if (opts?.refreshOutOfBox && outOfBox) {
      // 出厂态 + app 升级带来新出厂数据（大小不一致）→ 刷新；stat 失败则不强制
      try {
        if (fssync.existsSync(src) && fssync.statSync(src).size !== fssync.statSync(dest).size) {
          reason = 'refresh';
        }
      } catch {
        /* keep null */
      }
    }
    if (!reason) continue;
    try {
      if (!fssync.existsSync(src)) continue; // 出厂文件缺失（异常打包）→ 跳过，由网络更新兜底
      await fsp.mkdir(runtimeDir, { recursive: true });
      const tmp = `${dest}.seed-${process.pid}-${seedCounter++}`;
      await fsp.copyFile(src, tmp);
      // 落地前复查：missing 场景若 dest 期间已被 updateBuiltin 写入合法文件 → 放弃覆盖（防竞态回滚网络版）
      if (reason === 'missing' && isValidSrsFile(dest)) {
        await fsp.unlink(tmp).catch(() => {});
      } else {
        await fsp.rename(tmp, dest);
      }
    } catch {
      /* 单项补种失败不阻塞其余项；下次启动/列表刷新再试 */
    }
  }
}
