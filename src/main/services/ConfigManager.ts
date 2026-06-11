/**
 * 配置管理服务
 * 负责用户配置的加载、保存、验证和管理
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { UserConfig, Rule, RuleCondition } from '../../shared/types';
import { getConfigPath } from '../utils/paths';
import { readPrivacyHash, writePrivacyHash, hashPasswordSync } from '../utils/privacy-lock';
import {
  RULE_TYPE_IDS,
  validateRuleValue,
  migrateCustomRules,
  customRulesNeedMigration,
} from '../../shared/rules';

export interface IConfigManager {
  loadConfig(): Promise<UserConfig>;
  saveConfig(config: UserConfig): Promise<void>;
  get<T>(key: keyof UserConfig): T | undefined;
  set(key: keyof UserConfig, value: any): Promise<void>;
  validateConfig(config: UserConfig): void;
  getConfigPath(): string;
}

export class ConfigManager implements IConfigManager {
  private configPath: string;
  private currentConfig: UserConfig | null = null;
  private tmpSwept = false;

  /**
   * 清扫 saveConfig 原子写遗留的孤儿 tmp（进程在 writeFile 成功后、rename 前被硬杀/断电；随机名不会被下次写覆盖自愈）。
   * 仅首次 loadConfig 跑一次；mtime>60s 守卫避免误删并发 saveConfig 的在途 tmp；精确锚定文件名不碰 .pre-rule-migration.bak。best-effort，绝不抛。
   */
  private async sweepStaleTmpFiles(): Promise<void> {
    if (this.tmpSwept) return;
    this.tmpSwept = true;
    try {
      const dir = path.dirname(this.configPath);
      const base = path.basename(this.configPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${base}\\.[0-9a-f]{12}\\.tmp$`);
      const now = Date.now();
      const entries = await fs.readdir(dir);
      await Promise.all(
        entries
          .filter((f) => re.test(f))
          .map(async (f) => {
            const p = path.join(dir, f);
            try {
              const st = await fs.stat(p);
              if (now - st.mtimeMs > 60_000) await fs.unlink(p).catch(() => {});
            } catch {
              /* 文件已消失/无权限：忽略 */
            }
          })
      );
    } catch {
      /* 目录不存在/无权限等：忽略 */
    }
  }

  constructor(customConfigPath?: string) {
    if (customConfigPath) {
      this.configPath = customConfigPath;
    } else {
      // 使用统一的路径工具，确保始终使用正确的用户数据路径
      this.configPath = getConfigPath();
    }
  }

  /**
   * 获取配置文件路径
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * 加载配置文件
   * 如果文件不存在或损坏，返回默认配置
   */
  async loadConfig(): Promise<UserConfig> {
    void this.sweepStaleTmpFiles(); // 首次加载清扫原子写孤儿 tmp（fire-and-forget，不阻塞）
    try {
      // 检查配置文件是否存在
      await fs.access(this.configPath);

      // 读取配置文件
      const content = await fs.readFile(this.configPath, 'utf-8');
      const config = JSON.parse(content) as UserConfig;

      // 旧规则（DomainRule）→ 新规则（Rule）迁移前先备份原配置（仅首次，便于回滚）
      if (customRulesNeedMigration((config.customRules as unknown[]) || [])) {
        const backupPath = `${this.configPath}.pre-rule-migration.bak`;
        try {
          await fs.access(backupPath);
        } catch {
          await fs
            .copyFile(this.configPath, backupPath)
            .catch((e) => console.warn('备份旧配置失败（不阻断迁移）:', e));
        }
      }

      // 验证配置（内含旧规则 → 新规则迁移）
      this.validateConfig(config);

      // 旧配置回填 clash_api secret（首次升级时随机生成并持久化，后续稳定，供 external_ui/外部客户端复用）
      if (!config.clashApiSecret) {
        config.clashApiSecret = randomBytes(16).toString('hex');
        await this.saveConfig(config).catch((e) =>
          console.warn('持久化 clashApiSecret 失败（不阻断）:', e)
        );
      }

      // F29：旧明文 privacyPassword 一次性迁移到独立哈希文件（幂等、绝不抛）。
      // 先清内存明文——即便后续哈希落盘 fs 失败，明文也不会再经 CONFIG_GET_VALUE / configChanged 外泄；
      // 失败时磁盘明文留存，下次加载重试迁移（此期间无哈希=fail-open，与迁移失败语义一致）。
      if (typeof config.privacyPassword === 'string' && config.privacyPassword !== '') {
        const legacyPlain = config.privacyPassword;
        config.privacyPassword = '';
        try {
          if (!readPrivacyHash()) writePrivacyHash(hashPasswordSync(legacyPlain));
          await this.saveConfig(config).catch((e) =>
            console.warn('隐私密码迁移后落盘失败（不阻断）:', e)
          );
        } catch (e) {
          console.warn('[ConfigManager] 隐私密码迁移失败（明文已从内存清除，下次加载重试）:', e);
        }
      }

      // 缓存配置
      this.currentConfig = config;

      return config;
    } catch (error) {
      // 文件不存在或解析失败，返回默认配置
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn('配置文件加载失败，使用默认配置:', errorMessage);

      // 记录详细错误信息
      if (error instanceof SyntaxError) {
        console.error('配置文件 JSON 格式错误:', errorMessage);
      } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.info('配置文件不存在，将创建默认配置');
      } else if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        console.error('配置文件权限不足，无法读取');
      } else {
        console.error('配置验证失败:', errorMessage);
      }

      const defaultConfig = this.createDefaultConfig();
      this.currentConfig = defaultConfig;

      // 尝试保存默认配置
      try {
        await this.saveConfig(defaultConfig);
        console.info('默认配置已保存到:', this.configPath);
      } catch (saveError) {
        console.error('保存默认配置失败:', saveError);
        // 即使保存失败，也返回默认配置，让应用继续运行
      }

      return defaultConfig;
    }
  }

  /**
   * 保存配置文件
   */
  async saveConfig(config: UserConfig): Promise<void> {
    // 验证配置
    this.validateConfig(config);

    // 确保配置目录存在
    const configDir = path.dirname(this.configPath);
    await fs.mkdir(configDir, { recursive: true });

    // 原子落盘：先写唯一 tmp（随机后缀防并发 saveConfig 互相覆盖半写）→ rename 替换。
    // 防崩溃/进程被杀写到一半截断 config.json → loadConfig 校验失败回落默认配置并覆盖落盘 → 整份配置丢失
    //（节点/订阅/规则全丢）。与本项目 .srs/catalog 落盘同原子写规范（同样无 fsync → 断电 durability 为尽力而为）。
    const content = JSON.stringify(config, null, 2);
    const tmp = `${this.configPath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      // mode 在 open(2) 即生效（umask 只清位不加位）→ tmp 从创建起就是 0600，绝不出现 0644 携密窗口；
      // 否则崩溃落在 writeFile→chmod 之间会残留含全量 secrets 的 0644 文件。chmod 保留作双保险（兼容旧 fd 语义）。
      await fs.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 });
      if (process.platform !== 'win32') {
        await fs.chmod(tmp, 0o600);
      }
      await fs.rename(tmp, this.configPath);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {}); // 清理半写 tmp，避免脏文件堆积
      throw e;
    }

    // 更新缓存
    this.currentConfig = config;
  }

  /**
   * 获取配置项
   */
  get<T>(key: keyof UserConfig): T | undefined {
    if (!this.currentConfig) {
      return undefined;
    }
    return this.currentConfig[key] as T;
  }

  /**
   * 设置配置项
   */
  async set(key: keyof UserConfig, value: any): Promise<void> {
    if (!this.currentConfig) {
      this.currentConfig = this.createDefaultConfig();
    }

    // 更新配置项
    (this.currentConfig as any)[key] = value;

    // 保存配置
    await this.saveConfig(this.currentConfig);
  }

  /**
   * 验证配置有效性
   */
  validateConfig(config: UserConfig): void {
    // 验证必填字段
    if (!config) {
      throw new Error('Config is null or undefined');
    }

    // 自动迁移：强制将旧版本默认的高位端口（65533/65534）升级为标准端口（2080/2081）
    // 解决方法：如果用户当前设置的是旧默认值，自动将其重置为新默认值
    if (config.httpPort === 65533 || !config.httpPort) {
      config.httpPort = 2080;
    }
    if (config.socksPort === 65534 || !config.socksPort) {
      config.socksPort = 2081;
    }

    // 自动迁移：旧版自定义规则（DomainRule: domains+ipCidr）→ 新版 Rule（type+values）。
    // 必须在下方 customRules 校验之前（旧 shape 会被新校验判废 → loadConfig catch 覆盖保存 → 规则全丢）。
    // 幂等：已是新 shape 原样保留。
    if (Array.isArray(config.customRules) && customRulesNeedMigration(config.customRules)) {
      config.customRules = migrateCustomRules(config.customRules);
    }

    // 自动迁移：旧「排除进程」(bypassProcesses) → 自定义规则 processName+直连（功能等价，见设计评估）。
    // 追加到 customRules 末尾 → 在 rules 数组中的位置与旧 bypassProcesses 一致（所有自定义规则后、appRules 前），
    // 路由逐位等价。固定 id 天然幂等；清空 bypassProcesses 即迁移标记。必须在 customRules 软校验之前。
    if (Array.isArray(config.bypassProcesses) && config.bypassProcesses.length > 0) {
      // 非字符串元素（旁路 config:save/损坏备份导入可注入）走 typeof 守卫，避免 (123).trim() 抛错 →
      // validateConfig throw → loadConfig catch → 默认配置覆盖落盘 → servers/订阅/规则全丢（与 416 行同标准）。
      const values = Array.from(
        new Set(
          config.bypassProcesses.map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean)
        )
      );
      // 去重 id：仅手改/拼接配置可能让 customRules 已含同 id（正常路径成对落盘不会），防重复 id 致列表 React key 冲突 + 更新/删除只命中首条。
      const alreadyMigrated =
        Array.isArray(config.customRules) &&
        config.customRules.some((r) => r && r.id === 'migrated_bypass_processes');
      if (values.length > 0 && !alreadyMigrated) {
        if (!Array.isArray(config.customRules)) config.customRules = [];
        config.customRules.push({
          id: 'migrated_bypass_processes',
          type: 'processName',
          values,
          action: 'direct',
          enabled: true,
          remarks: '排除进程（自动迁移）',
        });
      }
      config.bypassProcesses = [];
    }

    // 验证 subscriptions 数组 (兼容旧配置)
    if (config.subscriptions) {
      if (!Array.isArray(config.subscriptions)) {
        throw new Error('subscriptions must be an array');
      }
      for (const sub of config.subscriptions) {
        if (!sub.id || typeof sub.id !== 'string') {
          throw new Error('Subscription id is required and must be a string');
        }
        if (!sub.name || typeof sub.name !== 'string') {
          throw new Error('Subscription name is required and must be a string');
        }
        if (!sub.url || typeof sub.url !== 'string') {
          throw new Error('Subscription url is required and must be a string');
        }
      }
    } else {
      config.subscriptions = [];
    }

    // 验证 servers 数组
    if (!Array.isArray(config.servers)) {
      throw new Error('servers must be an array');
    }

    // 验证每个服务器配置
    for (const server of config.servers) {
      if (!server.id || typeof server.id !== 'string') {
        throw new Error('Server id is required and must be a string');
      }
      if (!server.name || typeof server.name !== 'string') {
        throw new Error('Server name is required and must be a string');
      }
      const protocolLower = server.protocol?.toLowerCase();
      if (
        !protocolLower ||
        ![
          'vless',
          'vmess',
          'trojan',
          'hysteria2',
          'shadowsocks',
          'anytls',
          'tuic',
          'naive',
          'socks',
          'http',
          'ssh',
        ].includes(protocolLower)
      ) {
        throw new Error(
          'Server protocol must be vless, vmess, trojan, hysteria2, shadowsocks, anytls, tuic, naive, socks, http, or ssh'
        );
      }
      if (!server.address || typeof server.address !== 'string') {
        throw new Error('Server address is required and must be a string');
      }
      if (
        !server.port ||
        typeof server.port !== 'number' ||
        server.port < 1 ||
        server.port > 65535
      ) {
        throw new Error('Server port must be a number between 1 and 65535');
      }

      // VLESS 特定验证
      if (protocolLower === 'vless') {
        if (!server.uuid || typeof server.uuid !== 'string') {
          throw new Error('VLESS server requires uuid');
        }
      }

      // VMess 特定验证
      if (protocolLower === 'vmess') {
        if (!server.uuid || typeof server.uuid !== 'string') {
          throw new Error('VMess server requires uuid');
        }
      }

      // Trojan 特定验证
      if (protocolLower === 'trojan') {
        if (!server.password || typeof server.password !== 'string') {
          throw new Error('Trojan server requires password');
        }
      }

      // Hysteria2 特定验证
      if (protocolLower === 'hysteria2') {
        if (!server.password || typeof server.password !== 'string') {
          throw new Error('Hysteria2 server requires password');
        }
      }

      // TUIC 特定验证
      if (protocolLower === 'tuic') {
        if (!server.uuid || typeof server.uuid !== 'string') {
          throw new Error('TUIC server requires uuid');
        }
        if (!server.password || typeof server.password !== 'string') {
          throw new Error('TUIC server requires password');
        }
      }

      // Naive 特定验证
      if (protocolLower === 'naive') {
        if (!server.username || typeof server.username !== 'string') {
          throw new Error('Naive server requires username');
        }
        if (!server.password || typeof server.password !== 'string') {
          throw new Error('Naive server requires password');
        }
      }

      // Shadowsocks 特定验证
      if (protocolLower === 'shadowsocks') {
        if (!server.shadowsocksSettings) {
          throw new Error('Shadowsocks server requires shadowsocksSettings');
        }
        if (
          !server.shadowsocksSettings.method ||
          typeof server.shadowsocksSettings.method !== 'string'
        ) {
          throw new Error('Shadowsocks server requires encryption method');
        }
        if (
          !server.shadowsocksSettings.password ||
          typeof server.shadowsocksSettings.password !== 'string'
        ) {
          throw new Error('Shadowsocks server requires password');
        }
      }
    }

    // 验证 selectedServerId
    if (config.selectedServerId !== null) {
      if (typeof config.selectedServerId !== 'string') {
        throw new Error('selectedServerId must be a string or null');
      }
      // 检查服务器是否存在
      const serverExists = config.servers.some((s) => s.id === config.selectedServerId);
      if (!serverExists) {
        throw new Error('selectedServerId references a non-existent server');
      }
    }

    // 验证 proxyMode（不区分大小写）
    const proxyModeLower = config.proxyMode?.toLowerCase();
    if (!proxyModeLower || !['global', 'smart', 'direct'].includes(proxyModeLower)) {
      throw new Error('proxyMode must be global, smart, or direct');
    }

    // 验证 proxyModeType（不区分大小写）
    const modeTypeLower = config.proxyModeType?.toLowerCase();
    if (!modeTypeLower || !['systemproxy', 'tun', 'manual'].includes(modeTypeLower)) {
      throw new Error('proxyModeType must be systemProxy, tun, or manual');
    }

    // 验证 tunConfig
    if (!config.tunConfig) {
      throw new Error('tunConfig is required');
    }
    if (
      typeof config.tunConfig.mtu !== 'number' ||
      config.tunConfig.mtu < 1280 ||
      config.tunConfig.mtu > 65535
    ) {
      throw new Error('tunConfig.mtu must be a number between 1280 and 65535');
    }
    if (!['system', 'gvisor', 'mixed'].includes(config.tunConfig.stack)) {
      throw new Error('tunConfig.stack must be system, gvisor, or mixed');
    }
    if (typeof config.tunConfig.autoRoute !== 'boolean') {
      throw new Error('tunConfig.autoRoute must be a boolean');
    }
    if (typeof config.tunConfig.strictRoute !== 'boolean') {
      throw new Error('tunConfig.strictRoute must be a boolean');
    }

    // 校验 customRules（新 Rule shape）。**一律 console.warn 不 throw**：防单条脏数据触发整配置回落
    // 默认（loadConfig catch 会用默认配置覆盖保存 → 用户规则全丢）。结构非法的规则丢弃，值非法仅告警保留。
    if (!Array.isArray(config.customRules)) {
      config.customRules = [];
    }
    config.customRules = (config.customRules as Rule[]).filter((rule) => {
      if (!rule || typeof rule.id !== 'string' || !rule.id) {
        console.warn('[ConfigManager] 丢弃无 id 的规则');
        return false;
      }
      if (!RULE_TYPE_IDS.includes(rule.type)) {
        console.warn(`[ConfigManager] 丢弃未知类型规则: ${rule.id} type=${String(rule.type)}`);
        return false;
      }
      if (
        !Array.isArray(rule.values) ||
        !['proxy', 'direct', 'block'].includes(rule.action) ||
        typeof rule.enabled !== 'boolean'
      ) {
        console.warn(`[ConfigManager] 丢弃结构非法规则: ${rule.id}`);
        return false;
      }
      // 过滤非字符串 values 元素（旁路 config:save/备份导入可注入），防生成期 v.trim()/v.startsWith() 崩溃
      rule.values = rule.values.filter((v) => typeof v === 'string');
      for (const v of rule.values) {
        if (v.trim() && !validateRuleValue(rule.type, v)) {
          console.warn(
            `[ConfigManager] 规则值可能非法（保留）: ${rule.id} type=${rule.type} value=${v}`
          );
        }
      }
      // 多条件 conditions/combineMode sanitize（批J）：旁路注入可塞入非数组 conditions、非法
      // 类型 / 非字符串值 / 非法 combineMode，会让生成期 ruleConditions() 遍历崩溃。结构非法
      // 的整条 conditions 丢弃（退化为单条件 type/values），值非法仅告警保留（同 values 策略）。
      if (rule.conditions !== undefined) {
        if (!Array.isArray(rule.conditions)) {
          console.warn(`[ConfigManager] 规则 conditions 非数组，丢弃 conditions: ${rule.id}`);
          delete rule.conditions;
        } else {
          const cleaned: RuleCondition[] = [];
          for (const cond of rule.conditions) {
            if (
              !cond ||
              typeof cond !== 'object' ||
              !RULE_TYPE_IDS.includes((cond as RuleCondition).type)
            ) {
              console.warn(
                `[ConfigManager] 丢弃非法 condition: ${rule.id} type=${String((cond as RuleCondition)?.type)}`
              );
              continue;
            }
            const c = cond as RuleCondition;
            const vals = Array.isArray(c.values)
              ? c.values.filter((v) => typeof v === 'string')
              : [];
            if (vals.length === 0) {
              console.warn(`[ConfigManager] 丢弃空值 condition: ${rule.id} type=${c.type}`);
              continue;
            }
            for (const v of vals) {
              if (v.trim() && !validateRuleValue(c.type, v)) {
                console.warn(
                  `[ConfigManager] condition 值可能非法（保留）: ${rule.id} type=${c.type} value=${v}`
                );
              }
            }
            cleaned.push({ type: c.type, values: vals });
          }
          // 全部 condition 被丢弃 → 删除 conditions，退化为单条件（type/values 仍有效）；否则回写清洗后的
          if (cleaned.length === 0) {
            delete rule.conditions;
          } else {
            rule.conditions = cleaned;
            // 镜像同步：type/values 必须等于首条件（消费点/列表 Badge/回滚兼容均读镜像）。若 sanitize 丢了
            // 原 conditions[0]，镜像会指向一个不再参与生成的条件 → 强制重镜像 cleaned[0]，杜绝展示/生成错位。
            rule.type = cleaned[0].type;
            rule.values = [...cleaned[0].values];
          }
        }
      }
      if (
        rule.combineMode !== undefined &&
        rule.combineMode !== 'and' &&
        rule.combineMode !== 'or'
      ) {
        console.warn(`[ConfigManager] 规则 combineMode 非法，重置为默认: ${rule.id}`);
        delete rule.combineMode;
      }
      return true;
    });

    // 验证布尔值字段
    if (typeof config.autoStart !== 'boolean') {
      throw new Error('autoStart must be a boolean');
    }
    // silentStart 是新增字段，兼容旧配置
    if (config.silentStart !== undefined && typeof config.silentStart !== 'boolean') {
      throw new Error('silentStart must be a boolean');
    }
    if (config.silentStart === undefined) {
      config.silentStart = false; // 默认值
    }
    // appRoutingEnabled 新增字段：undefined=开启（兼容老配置，不回填以减少 config 写放大；gate 用 !== false）。
    // 纯开关字段非法值 sanitize 而非 throw——throw 在 loadConfig 路径会触发默认配置覆盖落盘致全丢，不值当。
    if (config.appRoutingEnabled !== undefined && typeof config.appRoutingEnabled !== 'boolean') {
      console.warn('appRoutingEnabled must be a boolean; resetting to default (enabled)');
      delete config.appRoutingEnabled;
    }
    // builtinGeoMeta 非法类型 sanitize 而非 throw（读取侧全容错、无爆炸半径，与 appRoutingEnabled 同型）
    if (
      config.builtinGeoMeta !== undefined &&
      (typeof config.builtinGeoMeta !== 'object' ||
        config.builtinGeoMeta === null ||
        Array.isArray(config.builtinGeoMeta))
    ) {
      console.warn('builtinGeoMeta must be an object; resetting to default');
      delete config.builtinGeoMeta;
    }
    // mainSessionViaProxy 新增字段：非法类型 sanitize（undefined=true 兼容老配置，gate 用 !== false）
    if (
      config.mainSessionViaProxy !== undefined &&
      typeof config.mainSessionViaProxy !== 'boolean'
    ) {
      console.warn('mainSessionViaProxy must be a boolean; resetting to default (enabled)');
      delete config.mainSessionViaProxy;
    }
    if (typeof config.autoConnect !== 'boolean') {
      throw new Error('autoConnect must be a boolean');
    }
    if (typeof config.minimizeToTray !== 'boolean') {
      throw new Error('minimizeToTray must be a boolean');
    }
    // autoCheckUpdate 是可选字段，兼容旧配置
    if (config.autoCheckUpdate !== undefined && typeof config.autoCheckUpdate !== 'boolean') {
      throw new Error('autoCheckUpdate must be a boolean');
    }
    // 如果未定义，设置默认值
    if (config.autoCheckUpdate === undefined) {
      config.autoCheckUpdate = true;
    }

    // autoLightweightMode 是可选字段，兼容旧配置
    if (
      config.autoLightweightMode !== undefined &&
      typeof config.autoLightweightMode !== 'boolean'
    ) {
      throw new Error('autoLightweightMode must be a boolean');
    }
    // 如果未定义，设置默认值
    if (config.autoLightweightMode === undefined) {
      config.autoLightweightMode = false;
    }

    // rememberWindowSize 是可选字段，兼容旧配置
    if (config.rememberWindowSize !== undefined && typeof config.rememberWindowSize !== 'boolean') {
      throw new Error('rememberWindowSize must be a boolean');
    }
    if (config.rememberWindowSize === undefined) {
      config.rememberWindowSize = false;
    }

    // bypassProcesses 是可选字段，兼容旧配置
    if (config.bypassProcesses === undefined) {
      config.bypassProcesses = [];
    }
    if (!Array.isArray(config.bypassProcesses)) {
      throw new Error('bypassProcesses must be an array');
    }

    // 验证端口
    if (typeof config.socksPort !== 'number' || config.socksPort < 1 || config.socksPort > 65535) {
      throw new Error('socksPort must be a number between 1 and 65535');
    }
    if (typeof config.httpPort !== 'number' || config.httpPort < 1 || config.httpPort > 65535) {
      throw new Error('httpPort must be a number between 1 and 65535');
    }

    // 验证日志级别
    if (!['debug', 'info', 'warn', 'error', 'fatal'].includes(config.logLevel)) {
      throw new Error('logLevel must be debug, info, warn, error, or fatal');
    }
  }

  /**
   * 创建默认配置
   */
  private createDefaultConfig(): UserConfig {
    return {
      subscriptions: [],
      servers: [],
      selectedServerId: null,
      proxyMode: 'global',
      proxyModeType: 'systemProxy', // 默认使用系统代理模式，不需要管理员权限
      tunConfig: {
        mtu: process.platform === 'darwin' ? 1400 : 1350,
        stack: process.platform === 'darwin' ? 'gvisor' : 'system',
        autoRoute: true,
        strictRoute: true,
      },
      customRules: [],
      autoStart: false,
      silentStart: false,
      autoConnect: false,
      minimizeToTray: true,
      autoCheckUpdate: true, // 默认启用启动时自动检查更新
      autoLightweightMode: false, // 默认不启用自动轻量模式
      autoUpdateSubscriptionOnStart: false, // 默认不启用订阅自动更新
      subscriptionUpdateIntervalHours: 12, // 订阅自动更新周期/陈旧阈值（小时）
      subscriptionUpdateViaProxy: false, // 默认直连拉取订阅
      mainSessionViaProxy: true, // 更新检查/规则资源默认走代理（运行时）
      rememberWindowSize: false, // 默认不启用记忆窗口大小
      enableIPv6: false, // 默认不启用 IPv6 解析（防假死兜底）
      autoPrivacyMode: false, // 默认不启用隐私模式
      privacyPassword: '', // 默认隐私模式密码为空

      // 默认 DNS 配置
      dnsConfig: {
        domesticDns: 'https://doh.pub/dns-query',
        foreignDns: 'https://dns.google/dns-query',
        enableFakeIp: false,
      },

      customRuleSets: [], // 默认空
      appRules: [], // 应用分流规则（实验性）默认空
      appRoutingEnabled: true, // 应用分流总开关默认开启（仅影响新装/回落；老配置 undefined 亦视为开启）

      socksPort: 2081,
      httpPort: 2080,
      logLevel: 'info',
      disableLogFile: false,
      clashApiSecret: randomBytes(16).toString('hex'),
      uiTheme: 'system',
    };
  }
}
