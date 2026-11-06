/**
 * DSH Backup Plugin - Host 插件入口
 *
 * 按 DSH 的 Host 插件导出约定实现（见 app.asar 内 `references/host-plugin.md`）：
 *   export function apply(ctx, config) {}
 *   export const inject = [...]      (可选；本插件不声明，避免可选的 tools 服务缺失时整包不激活)
 *   export const Config = ...        (可选)
 *
 * 历史教训：早先导出的是 `init()` 工厂，Loader 创建不出 fiber，启动诊断报
 * "did not activate backup-plugin (dsh-backup-rescue): failed to import"。
 */

import { registerBackupTools, resolveDefaults } from './tools.js';
import { registerRoutes } from './routes.js';
import { disposeScheduler, initScheduler } from './scheduler.js';
import { PLUGIN_VERSION } from './types.js';

/** Loader 行 id（cordis.patch.yml 中的 id）。 */
export const name = 'backup-plugin';

/** 插件版本。 */
export const version = PLUGIN_VERSION;

/** 插件描述。 */
export const description = 'DSH 全量备份插件 - 备份、恢复、导出、导入 DSH 所有配置';

/** 服务依赖：不依赖任何服务，保证在任何 profile 下都能激活。 */
export const inject: string[] = [];

/**
 * 从 types.ts 重新导出公共常量，供外部消费者使用。
 */
export { PLUGIN_VERSION, MANIFEST_NAME, ENC_MAGIC, BACKUP_FORMAT_VERSION } from './types.js';

/**
 * Cordis 插件入口。内部吞掉所有异常：工具注册失败只记日志，
 * 绝不因为一处失败让整个 profile 启动报错。
 */
export function apply(ctx: any, config: any = {}): void {
  const log = (message: string) => {
    try {
      console.log(message);
    } catch {
      /* logging must never throw */
    }
  };

  log(`[backup-plugin] apply() ${name}@${version}`);

  try {
    if (config && config.registerTools === false) {
      log('[backup-plugin] registerTools disabled by config');
    } else {
      const registered = registerBackupTools(ctx, log);
      log(`[backup-plugin] tools registered: ${registered.length} (${registered.join(', ') || 'none'})`);
    }
  } catch (error) {
    console.warn('[backup-plugin] unexpected tool registration failure:', error);
  }

  try {
    const mounted = registerRoutes(ctx, log);
    log(`[backup-plugin] routes mounted: ${mounted.length}`);
  } catch (error) {
    console.warn('[backup-plugin] unexpected route registration failure:', error);
  }

  // 自动备份调度器：读设置里的开关与间隔，未启用就只是挂个空表。
  try {
    const base = resolveDefaults();
    const scheduler = initScheduler({
      dshHome: base.dshHome,
      profileDir: base.profileDir,
      profileName: base.profileName,
      log,
    });
    const state = scheduler.start();
    log(`[backup-plugin] auto backup ${state.enabled ? `every ${state.intervalMinutes} min` : 'off'}`);
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => disposeScheduler(), 'backup-plugin: auto backup scheduler');
    }
  } catch (error) {
    console.warn('[backup-plugin] auto backup scheduler failed to start:', error);
  }

  log('[backup-plugin] activated');
}
