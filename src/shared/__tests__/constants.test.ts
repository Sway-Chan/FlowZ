/**
 * T4 — User-Agent 收敛单测。
 *
 * 背景：仓库曾散落多处 'FlowZ-Electron' 字面量，UA 维护漂移风险高。
 * 收敛目标：唯一字面量定义点 = src/shared/constants.ts 的 APP_USER_AGENT，
 *   其余消费点一律 import { APP_USER_AGENT }，禁止再出现裸字面量。
 *
 * 本测试双重锁定：
 *  1. APP_USER_AGENT 值正确且被导出（消费点 import 的契约）。
 *  2. 全仓 src/scripts 内 'FlowZ-Electron'（含双引号变体）字面量计数 == 1
 *     ——若有人重新引入裸字面量，此断言立刻红，强制收敛回常量。
 *
 * 注：grep 计数用 child_process 同步扫描磁盘真实文件，而非依赖 codegraph 索引
 *   （索引有秒级延迟，无法保证「当前磁盘真相」）。
 */
import * as cp from 'child_process';

import { APP_USER_AGENT } from '../constants';

// jest 默认 cwd = 仓库根（package.json 所在目录），用 process.cwd() 定位 src/scripts
// 比 __dirname 回溯更稳健（ts-jest 编译后 __dirname 指向内存模块路径，回溯层级不可靠）。
const REPO_ROOT = process.cwd();

describe('T4 APP_USER_AGENT 收敛', () => {
  it('值为 FlowZ-Electron 且已 export', () => {
    expect(APP_USER_AGENT).toBe('FlowZ-Electron');
    expect(typeof APP_USER_AGENT).toBe('string');
    // 空字符串 / 含空白均视为非法 UA
    expect(APP_USER_AGENT.trim()).toBe(APP_USER_AGENT);
    expect(APP_USER_AGENT.length).toBeGreaterThan(0);
  });

  it('全仓 src/scripts 仅剩 constants.ts 一处单引号字面量定义（无散落裸字面量）', () => {
    // 单引号字面量。grep -r 递归 --include 限定源码；--exclude-dir 排除 __tests__
    // （测试文件断言该值属合理引用，收敛目标是生产/脚本代码不出现裸字面量）。
    let single = '';
    try {
      single = cp.execSync(
        `grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" --include="*.cjs" --exclude-dir="__tests__" "'FlowZ-Electron'" src scripts`,
        { cwd: REPO_ROOT, encoding: 'utf-8' }
      );
    } catch {
      // grep 无匹配返非零退出码——但预期至少 constants.ts 一处命中，空即失败
    }

    // 仅 constants.ts 的定义行命中
    const hits = single.trim().split('\n').filter(Boolean);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('src/shared/constants.ts');
    expect(hits[0]).toMatch(/export\s+const\s+APP_USER_AGENT/);
  });

  it('全仓 src/scripts 无双引号 "FlowZ-Electron" 字面量变体', () => {
    // 双引号变体（防有人用另一套引号绕过单引号断言）。同样排除 __tests__。
    let double = '';
    try {
      double = cp.execSync(
        `grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" --include="*.cjs" --exclude-dir="__tests__" "\\"FlowZ-Electron\\"" src scripts`,
        { cwd: REPO_ROOT, encoding: 'utf-8' }
      );
    } catch {
      // grep 无匹配返非零退出码，属预期
    }
    expect(double.trim()).toBe('');
  });
});
