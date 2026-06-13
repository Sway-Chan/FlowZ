/**
 * 版本解析单一权威单测：encodeMajorMinor 基线矩阵 + sameMajorMinor 兼容带硬闸。
 * sameMajorMinor 是「内核自动更新跨 minor 绝不自动」的硬不变量基础 —— 必须 NaN 失败安全。
 */

import { encodeMajorMinor, sameMajorMinor } from '../version';

describe('encodeMajorMinor', () => {
  it('编码为 major*1000+minor', () => {
    expect(encodeMajorMinor('1.13.13')).toBe(1013);
    expect(encodeMajorMinor('1.20.3')).toBe(1020); // "1.20" 不被当 1.2
    expect(encodeMajorMinor('1.9.0')).toBe(1009);
    expect(encodeMajorMinor('2.0.0')).toBe(2000);
  });

  it('容忍前导 v 与任意后缀', () => {
    expect(encodeMajorMinor('v1.13.13')).toBe(1013);
    expect(encodeMajorMinor('1.13.13-beta')).toBe(1013);
    expect(encodeMajorMinor('1.13.13+naive')).toBe(1013);
    expect(encodeMajorMinor('v1.13')).toBe(1013);
  });

  it('无法解析返回 NaN', () => {
    expect(encodeMajorMinor('未知')).toBeNaN();
    expect(encodeMajorMinor('')).toBeNaN();
    expect(encodeMajorMinor('unknown')).toBeNaN();
    expect(encodeMajorMinor('v')).toBeNaN();
  });
});

describe('sameMajorMinor', () => {
  it('同 major.minor → true（仅 patch 不同）', () => {
    expect(sameMajorMinor('1.13.13', '1.13.14')).toBe(true);
    expect(sameMajorMinor('1.13.0', '1.13.99')).toBe(true);
    expect(sameMajorMinor('v1.13.13', '1.13.14-beta')).toBe(true); // 前导 v + 后缀混合
    expect(sameMajorMinor('1.13.5', '1.13.5')).toBe(true); // 完全相同
  });

  it('跨 minor → false（兼容带硬闸：绝不自动）', () => {
    expect(sameMajorMinor('1.13.13', '1.14.0')).toBe(false);
    expect(sameMajorMinor('1.13.13', '1.20.0')).toBe(false); // "1.20" 不误判同带
    expect(sameMajorMinor('1.13.13', '1.12.99')).toBe(false);
  });

  it('跨 major → false', () => {
    expect(sameMajorMinor('1.13.13', '2.13.13')).toBe(false);
    expect(sameMajorMinor('2.0.0', '1.0.0')).toBe(false);
  });

  it('任一无法解析（含"未知"）→ false（失败安全，宁可不更新）', () => {
    expect(sameMajorMinor('未知', '1.13.13')).toBe(false);
    expect(sameMajorMinor('1.13.13', '未知')).toBe(false);
    expect(sameMajorMinor('未知', '未知')).toBe(false);
    expect(sameMajorMinor('', '1.13.13')).toBe(false);
  });
});
