/**
 * 定时自动备份调度器。
 *
 * 规则（对应用户需求）：每隔 i 分钟做一次**普通备份**；只保留最近 j 份普通备份，
 * 超出的自动删最早的。全量备份永远不参与自动清理。
 *
 * 设计要点：
 *  - 定时器用递归 `setTimeout` 而不是 `setInterval`：一次备份要跑几十秒，
 *    setInterval 会在慢备份上叠加并发；递归 setTimeout 保证“上一次跑完才排下一次”。
 *  - 每次 tick 都重新读设置文件：用户改了间隔/开关，下一轮就生效，无需重启 DSH；
 *    设置页保存时也会调用 `applySettings()` 立即重排定时器。
 *  - 定时器 `unref()`：DSH 退出时不因为还挂着一个定时器而卡住进程。
 *  - 备份失败只记录 `lastError` 并继续下一轮，不中断调度。
 */

import { createBackup } from './backup.js';
import { pruneNormalBackups } from './prune.js';
import { effectiveBackupDir, loadSettings, type PluginSettings } from './settings.js';
import type { Logger } from './types.js';

export interface SchedulerOptions {
  /** $DSH_HOME。 */
  dshHome: string;
  /** 当前 profile 目录。 */
  profileDir: string;
  /** 当前 profile 名。 */
  profileName: string;
  /** 日志出口。 */
  log: Logger;
  /** 测试钩子：用毫秒覆盖“分钟”间隔（生产不传）。 */
  intervalMsOverride?: number;
}

export type TickStatus = 'ok' | 'error' | 'skipped';

export interface SchedulerState {
  running: boolean;
  enabled: boolean;
  intervalMinutes: number;
  maxBackups: number;
  backupDir: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: TickStatus | null;
  lastBackupPath: string | null;
  lastPruned: number;
  lastError: string | null;
  tickCount: number;
}

export interface TickResult {
  status: TickStatus;
  reason?: string;
  backupPath?: string;
  pruned?: number;
  error?: string;
  at: string;
}

/** 把“分钟”换成毫秒；测试可用 intervalMsOverride 直接给毫秒。 */
function intervalMsOf(settings: PluginSettings, override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  return Math.max(1, settings.autoBackup.intervalMinutes) * 60_000;
}

export class AutoBackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private state: SchedulerState;

  constructor(private readonly options: SchedulerOptions) {
    const settings = this.readSettings();
    this.state = {
      running: false,
      enabled: settings.autoBackup.enabled,
      intervalMinutes: settings.autoBackup.intervalMinutes,
      maxBackups: settings.autoBackup.maxBackups,
      backupDir: effectiveBackupDir(settings, options.dshHome),
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      lastBackupPath: null,
      lastPruned: 0,
      lastError: null,
      tickCount: 0,
    };
  }

  private readSettings(): PluginSettings {
    return loadSettings(this.options.dshHome);
  }

  /** 当前状态快照（给设置页展示“下次执行/上次结果”）。 */
  status(): SchedulerState {
    const settings = this.readSettings();
    return {
      ...this.state,
      enabled: settings.autoBackup.enabled,
      intervalMinutes: settings.autoBackup.intervalMinutes,
      maxBackups: settings.autoBackup.maxBackups,
      backupDir: effectiveBackupDir(settings, this.options.dshHome),
    };
  }

  /** 按当前设置启动/停止定时器；重复调用是安全的。 */
  start(): SchedulerState {
    this.stop();
    const settings = this.readSettings();
    this.state.enabled = settings.autoBackup.enabled;
    this.state.intervalMinutes = settings.autoBackup.intervalMinutes;
    this.state.maxBackups = settings.autoBackup.maxBackups;
    this.state.backupDir = effectiveBackupDir(settings, this.options.dshHome);
    if (!settings.autoBackup.enabled) {
      this.options.log('[backup-plugin] auto backup disabled');
      return this.status();
    }
    this.state.running = true;
    this.schedule(intervalMsOf(settings, this.options.intervalMsOverride));
    this.options.log(
      `[backup-plugin] auto backup every ${settings.autoBackup.intervalMinutes} min, keep ${settings.autoBackup.maxBackups}`,
    );
    return this.status();
  }

  /** 停止定时器（插件卸载时调用）。 */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.running = false;
    this.state.nextRunAt = null;
  }

  /** 设置变更后重排定时器。 */
  applySettings(): SchedulerState {
    return this.start();
  }

  private schedule(delayMs: number): void {
    this.state.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      void this.tickNow().finally(() => {
        if (!this.state.running) return;
        const settings = this.readSettings();
        this.schedule(intervalMsOf(settings, this.options.intervalMsOverride));
      });
    }, delayMs);
    // 定时器不应阻止进程退出
    const handle = this.timer as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') handle.unref();
  }

  /**
   * 执行一次“备份 + 清理”。
   *
   * `force=true` 时忽略 enabled 开关（设置页的“立即执行一次”用），其余情况
   * 未启用就跳过，避免手动 tick 破坏用户的开关意图。
   */
  async tickNow(force = false): Promise<TickResult> {
    const at = new Date().toISOString();
    if (this.ticking) {
      return { status: 'skipped', reason: 'busy', at };
    }
    const settings = this.readSettings();
    if (!settings.autoBackup.enabled && !force) {
      return { status: 'skipped', reason: 'disabled', at };
    }
    this.ticking = true;
    const backupDir = effectiveBackupDir(settings, this.options.dshHome);
    try {
      this.options.log(`[backup-plugin] auto backup start → ${backupDir}`);
      const backup = await createBackup({
        dshHome: this.options.dshHome,
        profileDir: this.options.profileDir,
        profileName: this.options.profileName,
        backupDir,
      });
      let pruned = 0;
      try {
        const result = pruneNormalBackups(backupDir, settings.autoBackup.maxBackups);
        pruned = result.removed.length;
        if (!result.ok) this.options.log(`[backup-plugin] auto prune partial: ${result.message}`);
      } catch (error) {
        this.options.log(`[backup-plugin] auto prune failed: ${String(error)}`);
      }
      this.state.tickCount += 1;
      this.state.lastRunAt = at;
      this.state.lastStatus = 'ok';
      this.state.lastBackupPath = backup.path;
      this.state.lastPruned = pruned;
      this.state.lastError = null;
      this.state.backupDir = backupDir;
      this.options.log(`[backup-plugin] auto backup done → ${backup.path} (pruned ${pruned})`);
      return { status: 'ok', backupPath: backup.path, pruned, at };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.tickCount += 1;
      this.state.lastRunAt = at;
      this.state.lastStatus = 'error';
      this.state.lastError = message;
      this.options.log(`[backup-plugin] auto backup failed: ${message}`);
      return { status: 'error', error: message, at };
    } finally {
      this.ticking = false;
    }
  }
}

/** 模块级单例：路由与工具共用同一个调度器。 */
let current: AutoBackupScheduler | null = null;

/** 创建（或替换）全局调度器。 */
export function initScheduler(options: SchedulerOptions): AutoBackupScheduler {
  if (current) current.stop();
  current = new AutoBackupScheduler(options);
  return current;
}

/** 取全局调度器；未初始化时返回 null（Headless 场景可能没有）。 */
export function getScheduler(): AutoBackupScheduler | null {
  return current;
}

/** 插件卸载时停表并释放单例。 */
export function disposeScheduler(): void {
  if (current) {
    current.stop();
    current = null;
  }
}
