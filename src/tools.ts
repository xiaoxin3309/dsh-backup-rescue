/**
 * 把备份能力注册成 agent 工具（backup_plugin_*）。
 *
 * 关键点（逆向自宿主实现，勿随意改动）：
 *  1. tools 服务是可选的，**不能**写在 `export const inject` 里，否则服务缺失时
 *     整个插件不会激活；必须用 `ctx.get('tools')` 取（Cordis 只在声明 inject 时
 *     才允许 `ctx.tools` 属性访问，否则抛 "cannot get property tools without inject"）。
 *  2. `tools.register(def)` 接受的是 `defineTool()` 产出的对象，形状为：
 *       { name, description, parameters: <JSON Schema>, output: { schema, render }, execute }
 *     其中 `output.render(args, value)` 必须返回 **content block 数组**
 *     （`[{ type: 'text', text }]`），不是字符串。
 *  3. 外部 bundle 无法 `import '@deepseek-ai/dsh-tools'`（其只存在于 app.asar 内），
 *     所以这里直接手写与 defineTool 等价的对象字面量——register 侧不做 marker 校验
 *     （marker 校验只存在于 sandbox 的动态工具路径）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { createBackup, listBackups, createFullBackup } from './backup.js';
import { restoreBackup, isDshRunning } from './restore.js';
import { backupAndUpdate } from './update.js';
import { migrateBackups } from './migrate.js';
import { pruneNormalBackups } from './prune.js';
import {
  defaultBackupDir,
  effectiveBackupDir,
  loadSettings,
  mergePatch,
  saveSettings,
  type SettingsPatch,
} from './settings.js';
import { getScheduler } from './scheduler.js';
import { type Logger, type DefaultsResult, PLUGIN_VERSION, type UpdateCheckResult, type UpdateResult } from './types.js';

export type { Logger, DefaultsResult };
export { PLUGIN_VERSION, createFullBackup };

/** 工具执行结果统一按 JSON 渲染。 */
function jsonRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return [{ type: 'text', text }];
}

const JSON_OUTPUT_DESCRIPTION = 'JSON result of the backup operation.';

/** 统一的工具定义工厂（等价于 @deepseek-ai/dsh-tools 的 defineTool）。 */
function defineToolLike(options: {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  execute: (args: any) => Promise<unknown> | unknown;
}): any {
  return {
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      properties: options.properties,
      ...(options.required && options.required.length > 0 ? { required: options.required } : {}),
      additionalProperties: false,
    },
    output: {
      schema: { type: 'json', description: JSON_OUTPUT_DESCRIPTION },
      render: jsonRender,
    },
    async execute(args: any) {
      return options.execute(args ?? {});
    },
  };
}

/** 推断当前 DSH 的 home / profile 目录，用户可以完全不传参数。 */
export function resolveDefaults(overrides: { dshHome?: string; profileDir?: string; profileName?: string } = {}): DefaultsResult {
  const dshHome = overrides.dshHome
    || process.env.DSH_HOME
    || path.join(homedir(), '.dsh');
  const profileDir = overrides.profileDir || path.join(dshHome, 'profiles', 'desktop');
  const profileName = overrides.profileName
    || process.env.DSH_PROFILE
    || path.basename(profileDir);
  return { dshHome, profileDir, profileName };
}

/** 生成全部工具定义。 */
export function buildToolDefinitions(log: Logger): any[] {
  return [
    defineToolLike({
      name: 'backup_plugin_create',
      description:
        'Create a full backup ZIP of the whole DSH installation (settings, ui, providers, plugins, mcp, prompts, skills, agent presets, agent instructions, workspaces, sessions, credentials status, plugin data/assets) and write a restore script next to it. All paths default to the running DSH installation, so it can be called with no arguments.',
      properties: {
        backupDir: { type: 'string', description: 'Output directory. Default: <DSH home>/dsh-backup-rescue/exports' },
        password: { type: 'string', description: 'Optional password; when set the archive is encrypted (DSHBK002: PBKDF2 + AES-256-CBC + HMAC)' },
        includeSecrets: { type: 'boolean', description: 'Include real credential values instead of status only (default false)' },
        includeNodeModules: { type: 'boolean', description: 'Also pack profiles/*/node_modules (the plugin code itself, ~hundreds of MB). Needed for an offline restore on another machine (default false)' },
        includeWorkspaces: { type: 'boolean', description: 'Also pack the workspace directories registered in storages/workspace.json (they live outside the DSH home). Restore puts them back at the rewritten paths (default false)' },
        excludePatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra glob patterns to skip, merged with the built-in exclusions',
        },
        dshHome: { type: 'string', description: 'Override DSH home directory' },
        profileDir: { type: 'string', description: 'Override profile directory' },
        profileName: { type: 'string', description: 'Override profile name' },
      },
      execute: async (args) => {
        const base = resolveDefaults(args);
        const backupDir = args.backupDir || path.join(base.dshHome, 'dsh-backup-rescue', 'exports');
        const result = await createBackup({
          dshHome: base.dshHome,
          profileDir: base.profileDir,
          profileName: base.profileName,
          backupDir,
          includeSecrets: args.includeSecrets === true,
          includeNodeModules: args.includeNodeModules === true,
          includeWorkspaces: args.includeWorkspaces === true,
          password: args.password,
          excludePatterns: Array.isArray(args.excludePatterns) ? args.excludePatterns : undefined,
        });
        log(`backup created: ${result.archive}`);
        return { ok: true, ...result };
      },
    }),

    defineToolLike({
      name: 'backup_plugin_list',
      description: 'List DSH backup ZIP files (with manifest summary) in a directory, newest first.',
      properties: {
        backupDir: { type: 'string', description: 'Directory to scan. Default: <DSH home>/dsh-backup-rescue/exports' },
        dshHome: { type: 'string', description: 'Override DSH home directory' },
      },
      execute: async (args) => {
        const base = resolveDefaults(args);
        const backupDir = args.backupDir || path.join(base.dshHome, 'dsh-backup-rescue', 'exports');
        const backups = listBackups(backupDir);
        return { ok: true, backupDir, count: backups.length, backups };
      },
    }),

    defineToolLike({
      name: 'backup_plugin_restore',
      description:
        'Restore a DSH backup ZIP. Verifies checksums, snapshots the current target into .backup-snapshot before writing, and refuses unknown paths. DSH must be closed for a full restore; use dryRun to preview only.',
      properties: {
        backupPath: { type: 'string', description: 'Path of the backup ZIP to restore' },
        targetDir: { type: 'string', description: 'Directory to restore into. Default: DSH home' },
        password: { type: 'string', description: 'Password for an encrypted archive' },
        dryRun: { type: 'boolean', description: 'Verify and list planned writes without changing anything' },
        rewritePaths: { type: 'boolean', description: 'Rewrite the old DSH home / username paths recorded in the backup to the restore target (default true, needed when moving to another machine)' },
        force: { type: 'boolean', description: 'Skip the "DSH is running" safety check' },
        dshHome: { type: 'string', description: 'Override DSH home directory' },
      },
      required: ['backupPath'],
      execute: async (args) => {
        const base = resolveDefaults(args);
        const targetDir = args.targetDir || base.dshHome;
        if (args.dryRun !== true && args.force !== true && isDshRunning()) {
          const message =
            'DSH appears to be running. Close DSH first, or pass force: true to overwrite anyway.';
          log(message);
          return { ok: false, error: 'dsh-running', message, targetDir };
        }
        const result = await restoreBackup({
          backupPath: args.backupPath,
          targetDir,
          password: args.password,
          dryRun: args.dryRun === true,
          rewritePaths: args.rewritePaths !== false,
        });
        log(`restore finished: ok=${String((result as any)?.ok)}`);
        return result;
      },
    }),

    defineToolLike({
      name: 'backup_plugin_status',
      description:
        'Report the detected DSH home / profile directory, whether DSH is currently running, and how many backups exist. Use this first when unsure which paths to pass.',
      properties: {
        backupDir: { type: 'string', description: 'Directory to inspect. Default: <DSH home>/dsh-backup-rescue/exports' },
        dshHome: { type: 'string', description: 'Override DSH home directory' },
        profileDir: { type: 'string', description: 'Override profile directory' },
      },
      execute: async (args) => {
        const base = resolveDefaults(args);
        const backupDir = args.backupDir || path.join(base.dshHome, 'dsh-backup-rescue', 'exports');
        const backups = listBackups(backupDir);
        return {
          ok: true,
          dshHome: base.dshHome,
          profileDir: base.profileDir,
          profileName: base.profileName,
          dshRunning: isDshRunning(),
          backupDir,
          backupCount: backups.length,
          newest: backups[0] ?? null,
        };
      },
    }),

    defineToolLike({
      name: 'backup_plugin_create_full',
      description:
        'Create a FULL backup that includes EVERYTHING: node_modules, dsh-runtimes, cache, logs, web-login, speech-to-text, and all other normally-excluded directories. Use this for "uninstall & reinstall DSH, then one-click restore" scenarios. WARNING: archive size may be several GB.',
      properties: {
        backupDir: { type: 'string', description: 'Output directory. Default: <DSH home>/dsh-backup-rescue/exports' },
        password: { type: 'string', description: 'Optional password; when set the archive is encrypted (DSHBK002: PBKDF2 + AES-256-CBC + HMAC)' },
        includeSecrets: { type: 'boolean', description: 'Include real credential values instead of status only (default false)' },
        dshHome: { type: 'string', description: 'Override DSH home directory' },
        profileDir: { type: 'string', description: 'Override profile directory' },
        profileName: { type: 'string', description: 'Override profile name' },
      },
      execute: async (args) => {
        const base = resolveDefaults(args);
        const backupDir = args.backupDir || path.join(base.dshHome, 'dsh-backup-rescue', 'exports');
        const result = await createFullBackup({
          dshHome: base.dshHome,
          profileDir: base.profileDir,
          profileName: base.profileName,
          backupDir,
          includeSecrets: args.includeSecrets === true,
          password: args.password,
          includeEverything: true,
        });
        log(`full backup created: ${result.archive} (${result.includedExtraDirs.length} extra dirs)`);
        return { ok: true, ...result };
      },
    }),

    defineToolLike({
      name: 'backup_plugin_check_update',
      description:
        'Check npm registry for the latest version of this plugin (dsh-backup-rescue). Returns current version, latest version, and whether an update is available.',
      properties: {},
      execute: async () => {
        try {
          const response = await fetch('https://registry.npmjs.org/dsh-backup-rescue/latest');
          if (!response.ok) {
            return { ok: false, currentVersion: PLUGIN_VERSION, latestVersion: 'N/A', isUpToDate: true, error: `npm registry returned HTTP ${response.status}` } as UpdateCheckResult;
          }
          const data = await response.json();
          const latestVersion = data.version || 'unknown';
          const isUpToDate = latestVersion === PLUGIN_VERSION;
          return {
            ok: true,
            currentVersion: PLUGIN_VERSION,
            latestVersion,
            isUpToDate,
            publishTime: data.time?.[latestVersion],
            changelogUrl: `https://www.npmjs.com/package/dsh-backup-rescue/v/${latestVersion}`,
          } as UpdateCheckResult;
        } catch (error) {
          return {
            ok: false,
            currentVersion: PLUGIN_VERSION,
            latestVersion: 'N/A',
            isUpToDate: true,
            error: error instanceof Error ? error.message : String(error),
          } as UpdateCheckResult;
        }
      },
    }),

    defineToolLike({
      name: 'backup_plugin_update',
      description:
        'One-click backup-then-update: first creates a NORMAL backup of the whole DSH installation, then installs the latest dsh-backup-rescue from npm. The backup always happens first, so a broken update can still be rolled back. Pass backup:false to update without backing up.',
      properties: {
        backup: { type: 'boolean', description: 'Create a normal backup before updating (default true)' },
        password: { type: 'string', description: 'Optional password for the automatic backup archive' },
        force: { type: 'boolean', description: 'Reinstall even when already on the latest version' },
        backupDir: { type: 'string', description: 'Backup output directory. Default: <DSH home>/dsh-backup-rescue/exports' },
      },
      execute: async (args) => {
        const base = resolveDefaults(args);
        const settings = loadSettings(base.dshHome);
        const result = await backupAndUpdate({
          dshHome: base.dshHome,
          profileDir: base.profileDir,
          profileName: base.profileName,
          backupDir: args.backupDir || effectiveBackupDir(settings, base.dshHome),
          backup: args.backup !== false,
          password: args.password,
          force: args.force === true,
        });
        log(`backup+update: ok=${String(result.ok)} ${result.oldVersion} -> ${result.newVersion}`);
        return result;
      },
    }),

    defineToolLike({
      name: 'backup_plugin_settings',
      description:
        'Read or change the backup plugin settings: where backups are stored (optionally migrating existing files), and the automatic backup schedule (every i minutes, keep the newest j normal backups). Returns the effective settings plus the scheduler state.',
      properties: {
        backupDir: { type: 'string', description: 'New backup root directory (absolute path). Pass an empty string to go back to the default location.' },
        migrate: { type: 'boolean', description: 'Move existing backups to the new directory (default true when backupDir changes)' },
        autoEnabled: { type: 'boolean', description: 'Turn the automatic backup schedule on or off' },
        autoIntervalMinutes: { type: 'number', description: 'Automatic backup interval in minutes (minimum 1)' },
        autoMaxBackups: { type: 'number', description: 'How many normal backups to keep; older ones are deleted (minimum 1)' },
      },
      execute: async (args) => {
        const base = resolveDefaults(args);
        const current = loadSettings(base.dshHome);
        const patch: SettingsPatch = {};
        if (typeof args.backupDir === 'string') patch.backupDir = args.backupDir.trim() ? args.backupDir : null;
        if (args.autoEnabled !== undefined || args.autoIntervalMinutes !== undefined || args.autoMaxBackups !== undefined) {
          patch.autoBackup = {};
          if (typeof args.autoEnabled === 'boolean') patch.autoBackup.enabled = args.autoEnabled;
          if (args.autoIntervalMinutes !== undefined) patch.autoBackup.intervalMinutes = Number(args.autoIntervalMinutes);
          if (args.autoMaxBackups !== undefined) patch.autoBackup.maxBackups = Number(args.autoMaxBackups);
        }

        const changed = Object.keys(patch).length > 0;
        if (!changed) {
          const settings = current;
          return {
            ok: true,
            settings,
            backupDir: effectiveBackupDir(settings, base.dshHome),
            defaultBackupDir: defaultBackupDir(base.dshHome),
            autoBackup: getScheduler()?.status() ?? null,
          };
        }

        const next = mergePatch(current, patch);
        const oldDir = effectiveBackupDir(current, base.dshHome);
        const newDir = effectiveBackupDir(next, base.dshHome);
        const migration = oldDir !== newDir && args.migrate !== false ? migrateBackups(oldDir, newDir) : null;
        fs.mkdirSync(newDir, { recursive: true });
        const saved = saveSettings(base.dshHome, next);
        const schedulerState = getScheduler()?.applySettings() ?? null;
        log(`settings updated: backupDir=${saved.backupDir ?? '(default)'} auto=${saved.autoBackup.enabled}`);
        return {
          ok: migration ? migration.ok : true,
          settings: saved,
          backupDir: effectiveBackupDir(saved, base.dshHome),
          migration,
          autoBackup: schedulerState,
        };
      },
    }),

    defineToolLike({
      name: 'backup_plugin_prune',
      description:
        'Delete the oldest NORMAL backups so that only maxBackups remain. Full backups are never touched. Defaults to the configured maxBackups.',
      properties: {
        maxBackups: { type: 'number', description: 'How many normal backups to keep (default: configured value)' },
        backupDir: { type: 'string', description: 'Backup root directory. Default: configured location' },
      },
      execute: async (args) => {
        const base = resolveDefaults(args);
        const settings = loadSettings(base.dshHome);
        const backupDir = args.backupDir || effectiveBackupDir(settings, base.dshHome);
        const maxBackups = typeof args.maxBackups === 'number' ? args.maxBackups : settings.autoBackup.maxBackups;
        const result = pruneNormalBackups(backupDir, maxBackups);
        log(`prune: ${result.message}`);
        return result;
      },
    }),
  ];
}

/**
 * 注册工具。任何失败都只记日志，绝不让 apply() 抛出（否则整个 bundle 会被判为
 * 激活失败）。
 *
 * 必须走 `ctx.inject(['tools'], ...)`：Cordis 只有在 inject 之后才解析服务，apply
 * 阶段直接 `ctx.get('tools')` 拿不到实例，工具会静默不注册。
 */
export function registerBackupTools(ctx: any, log: Logger): string[] {
  const registered: string[] = [];
  if (!ctx || typeof ctx.inject !== 'function') {
    log('[backup-plugin] ctx.inject unavailable — agent tools skipped');
    return registered;
  }

  const definitions = buildToolDefinitions(log);

  try {
    ctx.inject(['tools'], (toolCtx: any) => {
      const registry =
        toolCtx?.tools ?? (typeof toolCtx?.get === 'function' ? toolCtx.get('tools') : undefined);
      if (!registry || typeof registry.register !== 'function') {
        log('[backup-plugin] tools service unavailable — agent tools skipped');
        return;
      }

      const registerAll = () => {
        const disposers: Array<() => void> = [];
        for (const definition of definitions) {
          try {
            const disposer = registry.register(definition);
            registered.push(definition.name);
            log(`[backup-plugin] tool registered: ${definition.name}`);
            if (typeof disposer === 'function') disposers.push(disposer);
          } catch (error) {
            log(`[backup-plugin] tool registration failed (${definition.name}): ${String(error)}`);
          }
        }
        return () => {
          for (const disposer of disposers) {
            try {
              disposer();
            } catch {
              /* disposer lifecycle is best-effort */
            }
          }
        };
      };

      if (typeof toolCtx?.effect === 'function') {
        toolCtx.effect(registerAll, 'backup-plugin: agent tools');
      } else {
        registerAll();
      }
    });
  } catch (error) {
    log(`[backup-plugin] tools injection failed: ${String(error)}`);
  }

  return registered;
}
