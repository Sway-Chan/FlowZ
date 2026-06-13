/**
 * B-4 — LogManager.formatLogEntry 截断/对齐单测。
 *
 * 目标方法：LogManager.formatLogEntry（:218-229，私有）。
 *   source = entry.source.slice(0, 20).padEnd(20)  ← 超长 source 截到 20、短 source padEnd 对齐
 *   level  = entry.level.toUpperCase().padEnd(5)
 *   行格式：[timestamp] [LEVEL ] [source              ] message
 *
 * 触达路径：formatLogEntry 是私有，经公开 addLog → writeToFile → fs.appendFile 触达。
 *   故 mock fs/promises 的 appendFile 捕获落盘字符串，反向断言格式化结果。
 *
 * 隔离：
 *  - mkdir：让 ensureLogDirectory 直接 resolve（不真建目录）。
 *  - stat：抛 ENOENT 让 rotateLogIfNeeded 走「文件不存在不轮转」分支（避免触发 rename 链）。
 *  - appendFile：捕获 (path, data) 入参，resolve 空值。
 *  - logDir 传 os.tmpdir 子目录，绕开 electron getLogsPath。
 *
 * await：addLog 是 fire-and-forget（writeToFile 返回的 promise 存入 pendingWrites 但无公开 flush）。
 *   mock 后 appendFile 同步 resolve，writeToFile 内 await 链路在 microtask 排空后完成，
 *   故用 setImmediate 等一轮宏任务即可观测到 appendFile 被调。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-logformat-b4-'));

// 捕获 appendFile 落盘内容（每条日志一行字符串）
const appendCalls: string[] = [];

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  // stat 抛 ENOENT → rotateLogIfNeeded 判「文件不存在」跳过轮转，避免触发 rename 链
  stat: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  appendFile: jest.fn((_p: string, data: string) => {
    appendCalls.push(data);
    return Promise.resolve();
  }),
  // 兜底（rotateLogFiles 内可能用到，本测试不会触达）
  unlink: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  rename: jest.fn().mockResolvedValue(undefined),
}));

import { LogManager } from '../LogManager';

/** 排空 microtask + 一轮宏任务，让 addLog → writeToFile → appendFile 链路落地。 */
function flushWrites(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 从格式化后的日志行提取 source 段内容。
 *  行格式：[ts] [LEVEL] [source] msg。级别段 padEnd(5) 恒 5 字符（ERROR/FATAL 恰填满、WARN/INFO 带尾空格），
 *  故用 [A-Z ]{5} 精确匹配级别段，第三组方括号内即为 source（已 slice+padEnd 处理过）。 */
function extractSource(line: string): string {
  const m = line.match(/\] \[[A-Z ]{5}\] \[([^\]]*)\] /);
  if (!m) throw new Error(`source 段未匹配，line=${JSON.stringify(line)}`);
  return m[1];
}

describe('B-4 formatLogEntry 截断/对齐', () => {
  let lm: LogManager;

  beforeEach(() => {
    appendCalls.length = 0;
    lm = new LogManager(TMP);
    // 默认 currentLogLevel=info；error/fatal 一定放行，info 也放行
    lm.setLogLevel('info');
  });

  it('超长 source 截断为 20 字符（不溢出对齐列）', async () => {
    const longSource = 'A'.repeat(50); // 50 字符，远超 20
    lm.addLog('error', 'msg-trunc', longSource);
    await flushWrites();

    expect(appendCalls).toHaveLength(1);
    const line = appendCalls[0];

    const sourceField = extractSource(line);
    expect(sourceField).toHaveLength(20);
    expect(sourceField).toBe('A'.repeat(20)); // 前 20 字符，未 padEnd（恰好填满）
    expect(line).toContain('msg-trunc');
  });

  it('短 source padEnd 对齐到 20 字符宽度', async () => {
    lm.addLog('warn', 'msg-pad', 'ProxyManager');
    await flushWrites();

    const line = appendCalls[0];
    const sourceField = extractSource(line);
    expect(sourceField).toHaveLength(20);
    // ProxyManager(12) + 8 个空格 padEnd
    expect(sourceField).toBe('ProxyManager'.padEnd(20));
  });

  it('恰好 20 字符的 source 不截断也不填充', async () => {
    const exact = 'B'.repeat(20);
    lm.addLog('error', 'msg-exact', exact);
    await flushWrites();

    const line = appendCalls[0];
    const sourceField = extractSource(line);
    expect(sourceField).toBe(exact);
    expect(sourceField).toHaveLength(20);
  });

  it('空 source 仍 padEnd 为 20 个空格（对齐列不塌陷）', async () => {
    lm.addLog('error', 'msg-empty', '');
    await flushWrites();

    const line = appendCalls[0];
    const sourceField = extractSource(line);
    expect(sourceField).toHaveLength(20);
    expect(sourceField).toBe(' '.repeat(20));
  });

  it('level padEnd(5) 对齐：error/warn/info/debug 同列宽', async () => {
    // 各级别分别记一条（error/warn 放行，info/debug 当前 logLevel=info 下 info 放行 debug 丢弃）
    lm.addLog('error', 'm1', 'S');
    lm.addLog('warn', 'm2', 'S');
    lm.addLog('info', 'm3', 'S');
    await flushWrites();

    expect(appendCalls).toHaveLength(3);
    for (const line of appendCalls) {
      const levelMatch = line.match(/\] \[([A-Z\s]+)\] \[/);
      expect(levelMatch).not.toBeNull();
      expect(levelMatch![1]).toHaveLength(5);
    }
  });

  it('完整行格式：[ts] [LEVEL] [source] message（含方括号定界与字段顺序）', async () => {
    lm.addLog('error', 'hello-world', 'ConfigManager');
    await flushWrites();

    const line = appendCalls[0];
    // 严格匹配整体结构：[ISO时间] [级别] [源] 消息
    expect(line).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/ // ISO timestamp 起始
    );
    expect(line).toContain('[ERROR]'); // 大写 + padEnd(5)
    expect(line).toContain('[ConfigManager       ]'); // 12 + 8 空格
    // writeToFile 在 line 末尾追加 '\n'，故 message 后跟换行
    expect(line).toMatch(/hello-world\s*$/);
  });

  it('含 stack 的条目追加换行 + stack 内容', async () => {
    lm.addLog('fatal', 'crashed', 'Kernel', 'Error: boom\n  at foo:1:1');
    await flushWrites();

    const line = appendCalls[0];
    expect(line).toContain('crashed');
    expect(line).toContain('\nError: boom');
    expect(line).toContain('at foo:1:1');
  });
});
