/**
 * Host 侧 REST 路由（给设置页 UI 用）。
 *
 * 路由对象形状逆向自宿主 `dsh-host-webserver` 契约（与 dsh-config-manager 的 kit 一致）：
 *   { kind: 'exact', path: '/api/xxx', handler: async (req, res) => {} }
 * 通过 `ctx.get('webServer')` 拿到 registry，再 `registry.register(route)`。
 * webServer 是可选的（Headless profile 里没有），因此全程降级、不抛异常。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackup, listBackups, createFullBackup } from './backup.js';
import { restoreBackup, isDshRunning } from './restore.js';
import { backupAndUpdate } from './update.js';
import { migrateBackups } from './migrate.js';
import { pruneNormalBackups } from './prune.js';
import {
  defaultBackupDir,
  effectiveBackupDir,
  isDefaultSettings,
  loadSettings,
  mergePatch,
  saveSettings,
  type SettingsPatch,
} from './settings.js';
import { getScheduler } from './scheduler.js';
import { resolveDefaults, type Logger, PLUGIN_VERSION } from './tools.js';

const API_BASE = '/api/dsh-backup-rescue';

function writeJson(res: any, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: any): Promise<Record<string, any> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) return undefined;
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

/** 只允许本机回环访问，避免远程页面驱动备份/恢复。 */
function isLoopback(req: any): boolean {
  const address = req?.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  return req?.headers?.['sec-fetch-site'] !== 'cross-site';
}

/** 当前生效的备份根目录（设置优先，否则默认位置）。 */
function currentBackupDir(dshHome: string): string {
  return effectiveBackupDir(loadSettings(dshHome), dshHome);
}

/** 构造全部路由。 */
export function buildRoutes(log: Logger): Array<{ kind: string; path: string; handler: (req: any, res: any) => Promise<void> }> {
  return [
    {
      kind: 'exact',
      path: `${API_BASE}/status`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' });
        const base = resolveDefaults();
        const settings = loadSettings(base.dshHome);
        const backupDir = effectiveBackupDir(settings, base.dshHome);
        const backups = listBackups(backupDir);
        writeJson(res, 200, {
          ok: true,
          pluginVersion: PLUGIN_VERSION,
          dshHome: base.dshHome,
          profileDir: base.profileDir,
          profileName: base.profileName,
          dshRunning: isDshRunning(),
          backupDir,
          isDefaultBackupDir: isDefaultSettings(settings, base.dshHome),
          // 一般备份与全量备份分别落在两个固定子目录里（每份备份再自带一个同名文件夹）
          backupDirs: {
            normal: path.join(backupDir, 'normal'),
            full: path.join(backupDir, 'full'),
          },
          backupCount: backups.length,
          backups,
          settings,
          autoBackup: getScheduler()?.status() ?? null,
        });
      },
    },

    {
      kind: 'exact',
      path: `${API_BASE}/create`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        const body = await readJsonBody(req);
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' });
        try {
          const base = resolveDefaults();
          const result = await createBackup({
            dshHome: base.dshHome,
            profileDir: base.profileDir,
            profileName: base.profileName,
            backupDir: typeof body.backupDir === 'string' && body.backupDir ? body.backupDir : currentBackupDir(base.dshHome),
            includeSecrets: body.includeSecrets === true,
            // 用户勾了“包含插件文件”时，一般备份也把 node_modules 一起打包
            includeNodeModules: body.includeNodeModules === true,
            includeWorkspaces: body.includeWorkspaces === true,
            password: typeof body.password === 'string' && body.password ? body.password : undefined,
          });
          log(`[backup-plugin] backup created via UI: ${result.archive}`);
          writeJson(res, 200, {
            ok: true,
            archive: result.archive,
            folder: result.folder,
            restoreBat: result.restoreBat ?? null,
            encrypted: result.encrypted,
            includedNodeModules: result.manifest.includedNodeModules === true,
            fileCount: result.fileCount,
            totalBytes: result.totalBytes,
            note: result.manifest.includedNodeModules === true
              ? '本次包含插件文件（node_modules），恢复后可直接使用；zip 与恢复脚本在同一同名文件夹。'
              : 'zip 与恢复脚本已放进同一个同名文件夹；恢复时双击那个与备份同名的 .bat。',
          });
        } catch (error) {
          log(`[backup-plugin] backup failed: ${String(error)}`);
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },

    {
      kind: 'exact',
      path: `${API_BASE}/create-full`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        const body = await readJsonBody(req);
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' });
        try {
          const base = resolveDefaults();
          const result = await createFullBackup({
            dshHome: base.dshHome,
            profileDir: base.profileDir,
            profileName: base.profileName,
            backupDir: typeof body.backupDir === 'string' && body.backupDir ? body.backupDir : currentBackupDir(base.dshHome),
            includeSecrets: body.includeSecrets === true,
            password: typeof body.password === 'string' && body.password ? body.password : undefined,
            includeEverything: true,
            includeWorkspaces: body.includeWorkspaces === true,
          });
          log(`[backup-plugin] full backup created via UI: ${result.archive}`);
          writeJson(res, 200, {
            ok: true,
            archive: result.archive,
            folder: result.folder,
            restoreBat: result.restoreBat ?? null,
            encrypted: result.encrypted,
            fileCount: result.fileCount,
            totalBytes: result.totalBytes,
            includedExtraDirs: result.includedExtraDirs,
            note: result.note,
          });
        } catch (error) {
          log(`[backup-plugin] full backup failed: ${String(error)}`);
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },

    {
      kind: 'exact',
      path: `${API_BASE}/restore`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        const body = await readJsonBody(req);
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' });
        if (typeof body.backupPath !== 'string' || !body.backupPath) {
          return writeJson(res, 400, { error: 'backupPath is required' });
        }
        if (body.force !== true && isDshRunning()) {
          return writeJson(res, 409, {
            error: 'dsh-running',
            message: 'DSH 正在运行，无法整体恢复。请先退出 DSH，再运行备份目录里的 restore.bat。',
          });
        }
        try {
          const base = resolveDefaults();
          const result = await restoreBackup({
            backupPath: body.backupPath,
            targetDir: typeof body.targetDir === 'string' && body.targetDir ? body.targetDir : base.dshHome,
            password: typeof body.password === 'string' && body.password ? body.password : undefined,
            dryRun: body.dryRun === true,
            // 默认把旧 home / 旧用户名路径改写为恢复目标的路径（换机器时必需）
            rewritePaths: body.rewritePaths !== false,
          });
          log(`[backup-plugin] restore via UI: ok=${String((result as any)?.ok)}`);
          if (result.ok === false && /已加密/.test(result.message)) {
            return writeJson(res, 400, { error: 'password-required', message: result.message });
          }
          writeJson(res, 200, result);
        } catch (error) {
          log(`[backup-plugin] restore failed: ${String(error)}`);
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },

    {
      kind: 'exact',
      path: `${API_BASE}/update-check`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' });
        if (req.method !== 'GET') return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        try {
          const response = await fetch('https://registry.npmjs.org/dsh-backup-rescue/latest');
          if (!response.ok) {
            return writeJson(res, 200, {
              ok: false,
              currentVersion: PLUGIN_VERSION,
              latestVersion: 'N/A',
              isUpToDate: true,
              error: `npm registry returned HTTP ${response.status}`,
            });
          }
          const data = await response.json();
          const latestVersion = data.version || 'unknown';
          const isUpToDate = latestVersion === PLUGIN_VERSION;
          writeJson(res, 200, {
            ok: true,
            currentVersion: PLUGIN_VERSION,
            latestVersion,
            isUpToDate,
            publishTime: data.time?.[latestVersion],
            changelogUrl: `https://www.npmjs.com/package/dsh-backup-rescue/v/${latestVersion}`,
          });
        } catch (error) {
          writeJson(res, 200, {
            ok: false,
            currentVersion: PLUGIN_VERSION,
            latestVersion: 'N/A',
            isUpToDate: true,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },

    {
      kind: 'exact',
      path: `${API_BASE}/update`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        const body = await readJsonBody(req);
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' });
        try {
          const base = resolveDefaults();
          const result = await backupAndUpdate({
            dshHome: base.dshHome,
            profileDir: base.profileDir,
            profileName: base.profileName,
            backupDir: typeof body.backupDir === 'string' && body.backupDir ? body.backupDir : currentBackupDir(base.dshHome),
            // 一键备份并更新：默认先备份；显式传 backup:false 才跳过
            backup: body.backup !== false,
            password: typeof body.password === 'string' && body.password ? body.password : undefined,
            force: body.force === true,
          });
          log(`[backup-plugin] backup+update: ok=${String(result.ok)} ${result.oldVersion} -> ${result.newVersion}`);
          writeJson(res, 200, result);
        } catch (error) {
          log(`[backup-plugin] backup+update failed: ${String(error)}`);
          writeJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/settings`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' });
        const base = resolveDefaults();
        const settings = loadSettings(base.dshHome);

        if (req.method === 'GET') {
          const backupDir = effectiveBackupDir(settings, base.dshHome);
          return writeJson(res, 200, {
            ok: true,
            settings,
            backupDir,
            defaultBackupDir: defaultBackupDir(base.dshHome),
            backupDirs: { normal: path.join(backupDir, 'normal'), full: path.join(backupDir, 'full') },
            autoBackup: getScheduler()?.status() ?? null,
          });
        }

        if (req.method !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        const body = await readJsonBody(req);
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' });

        try {
          const patch: SettingsPatch = {};
          const wantsDirChange = Object.prototype.hasOwnProperty.call(body, 'backupDir');
          if (wantsDirChange) {
            const raw = body.backupDir;
            if (raw !== null && typeof raw !== 'string') return writeJson(res, 400, { error: 'backupDir must be a string or null' });
            patch.backupDir = typeof raw === 'string' ? raw : null;
          }
          if (body.autoBackup && typeof body.autoBackup === 'object') {
            const auto = body.autoBackup as Record<string, unknown>;
            patch.autoBackup = {};
            if (typeof auto.enabled === 'boolean') patch.autoBackup.enabled = auto.enabled;
            if (auto.intervalMinutes !== undefined) patch.autoBackup.intervalMinutes = Number(auto.intervalMinutes);
            if (auto.maxBackups !== undefined) patch.autoBackup.maxBackups = Number(auto.maxBackups);
          }

          const next = mergePatch(settings, patch);
          // 用户填了非空字符串却被规范化成 null，说明它不是一个合法的绝对路径
          if (wantsDirChange && typeof patch.backupDir === 'string' && patch.backupDir.trim() && next.backupDir === null) {
            return writeJson(res, 400, { error: 'backupDir 必须是绝对路径，例如 D:\\DSH-Backups' });
          }

          const oldDir = effectiveBackupDir(settings, base.dshHome);
          const newDir = effectiveBackupDir(next, base.dshHome);
          let migration: ReturnType<typeof migrateBackups> | null = null;
          if (wantsDirChange && oldDir !== newDir && body.migrate !== false) {
            migration = migrateBackups(oldDir, newDir);
            log(`[backup-plugin] migrate: ${migration.message}`);
          }
          try {
            fs.mkdirSync(newDir, { recursive: true });
          } catch (error) {
            return writeJson(res, 500, {
              ok: false,
              error: `无法创建备份目录 ${newDir}: ${error instanceof Error ? error.message : String(error)}`,
              migration,
            });
          }

          const saved = saveSettings(base.dshHome, next);
          const schedulerState = getScheduler()?.applySettings() ?? null;
          log(
            `[backup-plugin] settings saved: backupDir=${saved.backupDir ?? '(default)'} auto=${
              saved.autoBackup.enabled ? `${saved.autoBackup.intervalMinutes}min/${saved.autoBackup.maxBackups}` : 'off'
            }`,
          );
          writeJson(res, 200, {
            ok: migration ? migration.ok : true,
            settings: saved,
            backupDir: effectiveBackupDir(saved, base.dshHome),
            defaultBackupDir: defaultBackupDir(base.dshHome),
            backupDirs: {
              normal: path.join(effectiveBackupDir(saved, base.dshHome), 'normal'),
              full: path.join(effectiveBackupDir(saved, base.dshHome), 'full'),
            },
            migration,
            autoBackup: schedulerState,
          });
        } catch (error) {
          log(`[backup-plugin] settings update failed: ${String(error)}`);
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },

    {
      kind: 'exact',
      path: `${API_BASE}/prune`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' });
        if (req.method !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        const body = await readJsonBody(req);
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' });
        try {
          const base = resolveDefaults();
          const settings = loadSettings(base.dshHome);
          const backupDir = currentBackupDir(base.dshHome);
          const rawMax = body.maxBackups;
          const maxBackups =
            typeof rawMax === 'number' && Number.isFinite(rawMax) ? Math.round(rawMax) : settings.autoBackup.maxBackups;
          const result = pruneNormalBackups(backupDir, maxBackups);
          log(`[backup-plugin] prune via UI: ${result.message}`);
          writeJson(res, result.ok ? 200 : 500, result);
        } catch (error) {
          log(`[backup-plugin] prune failed: ${String(error)}`);
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
  ];
}

/**
 * 把路由挂到 webServer 上。返回已挂载路径列表；webServer 缺失时返回空数组。
 *
 * 必须走 `ctx.inject(['webServer'], ...)`：Cordis 里服务只有在 inject 之后才会被解析，
 * 直接 `ctx.get('webServer')` 在 apply 阶段拿不到实例（设置页因此报 HTTP 404）。
 * 注册要包在 `sctx.effect()` 里，插件卸载时才会注销路由。
 */
export function registerRoutes(ctx: any, log: Logger): string[] {
  const mounted: string[] = [];
  if (!ctx || typeof ctx.inject !== 'function') {
    log('[backup-plugin] ctx.inject unavailable — settings-page API skipped');
    return mounted;
  }

  try {
    ctx.inject(['webServer'], (webCtx: any) => {
      const registry =
        webCtx?.webServer ?? (typeof webCtx?.get === 'function' ? webCtx.get('webServer') : undefined);
      if (!registry || typeof registry.register !== 'function') {
        log('[backup-plugin] webServer unavailable — settings-page API skipped');
        return;
      }

      const routes = buildRoutes(log);
      const registerAll = () => {
        const disposers: Array<() => void> = [];
        for (const route of routes) {
          try {
            const dispose = registry.register(route);
            mounted.push(route.path);
            log(`[backup-plugin] route mounted: ${route.path}`);
            if (typeof dispose === 'function') disposers.push(dispose);
          } catch (error) {
            log(`[backup-plugin] route failed (${route.path}): ${String(error)}`);
          }
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* best effort */
            }
          }
        };
      };

      if (typeof webCtx?.effect === 'function') {
        webCtx.effect(registerAll, 'backup-plugin: http routes');
      } else {
        registerAll();
      }
    });
  } catch (error) {
    log(`[backup-plugin] webServer injection failed: ${String(error)}`);
  }

  return mounted;
}
