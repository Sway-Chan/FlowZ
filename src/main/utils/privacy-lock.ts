/**
 * 隐私模式密码哈希存储（main 独占）。
 *
 * 安全定位：本特性是「前端威慑闸」加固，非 auth-grade 安全——但密码绝不以明文落盘、绝不下发渲染端。
 * 设计要点（相对把哈希塞进 UserConfig 的低风险变体）：哈希存独立文件 privacy-lock.json，
 * 永不进入 config 对象 → 无需在 10+ 个 configChanged 广播点 / CONFIG_GET / CONFIG_SAVE 做脱敏与
 * merge 保护，消除了那条高风险面。渲染端只能经 IPC 拿到 hasPassword 布尔与 verify 结果。
 *
 * 算法：Node 内建 scrypt（memory-hard，零新依赖），交互档参数 N=2^14/r=8/p=1，每密码独立随机盐，
 * timingSafeEqual 等长比较。
 */
import { app } from 'electron';
import { scrypt, scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface PrivacyPasswordHash {
  algo: 'scrypt';
  salt: string; // hex, 16B
  hash: string; // hex, 32B 派生密钥
  params: { N: number; r: number; p: number; keyLen: number };
}

const PARAMS = { N: 16384, r: 8, p: 1, keyLen: 32 } as const;
const MAXMEM = 64 * 1024 * 1024; // 16MiB 实际占用留余量（Node 默认上限 32MiB）

function lockPath(): string {
  return path.join(app.getPath('userData'), 'privacy-lock.json');
}

/** 异步派生（verify / 设置密码用，不阻塞 main loop）。 */
export function hashPassword(plain: string): Promise<PrivacyPasswordHash> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(
      plain,
      salt,
      PARAMS.keyLen,
      { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: MAXMEM },
      (err, dk) => {
        if (err) reject(err);
        else
          resolve({
            algo: 'scrypt',
            salt: salt.toString('hex'),
            hash: dk.toString('hex'),
            params: { ...PARAMS },
          });
      }
    );
  });
}

/** 同步派生（一次性迁移用，启动期 ~100ms）。 */
export function hashPasswordSync(plain: string): PrivacyPasswordHash {
  const salt = randomBytes(16);
  const dk = scryptSync(plain, salt, PARAMS.keyLen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: MAXMEM,
  });
  return {
    algo: 'scrypt',
    salt: salt.toString('hex'),
    hash: dk.toString('hex'),
    params: { ...PARAMS },
  };
}

/** 校验：参数/结构异常一律返回 false，绝不抛。 */
export function verifyPassword(plain: string, h: PrivacyPasswordHash): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (!h || h.algo !== 'scrypt' || !h.salt || !h.hash || !h.params) return resolve(false);
      const salt = Buffer.from(h.salt, 'hex');
      const expected = Buffer.from(h.hash, 'hex');
      scrypt(
        plain,
        salt,
        h.params.keyLen,
        { N: h.params.N, r: h.params.r, p: h.params.p, maxmem: MAXMEM },
        (err, dk) => {
          if (err || dk.length !== expected.length) return resolve(false);
          resolve(timingSafeEqual(dk, expected));
        }
      );
    } catch {
      resolve(false);
    }
  });
}

function isValidHash(v: unknown): v is PrivacyPasswordHash {
  const h = v as PrivacyPasswordHash;
  return (
    !!h &&
    h.algo === 'scrypt' &&
    typeof h.salt === 'string' &&
    typeof h.hash === 'string' &&
    !!h.params &&
    typeof h.params.N === 'number'
  );
}

/** 读哈希；文件缺失/损坏 → null（= 未设密码，fail-open，符合威慑闸语义）。 */
export function readPrivacyHash(): PrivacyPasswordHash | null {
  try {
    const raw = fs.readFileSync(lockPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return isValidHash(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 写哈希（null = 清除密码，删除文件）。非 Windows 设 0600。 */
export function writePrivacyHash(h: PrivacyPasswordHash | null): void {
  const p = lockPath();
  if (h === null) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(h), 'utf-8');
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      /* ignore */
    }
  }
}

export function hasPrivacyPassword(): boolean {
  return readPrivacyHash() !== null;
}
