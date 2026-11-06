/**
 * DSH Backup Plugin - 「一键备份并更新」
 *
 * 语义（0.3.3 起）：先把整个 DSH 做一份**一般备份**，再从 npm 把本插件升到最新版。
 * 顺序不能反 —— 更新可能换来一个跑不起来的插件，那时用户手上必须已经有一份能恢复的备份。
 *
 * 安装方式按 profile 实际情况猜，按顺序回退：
 *   1. profile 里有 pnpm-lock.yaml → 用 dsh-runtimes 里自带的 pnpm（node <pnpm.mjs> add）
 *   2. 退回 npm（npm install --save），保证没有 pnpm 的机器也能更新
 * 每一步的输出都进 log，失败时整段回传给设置页，方便直接贴给作者。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBackup } from './backup.js';
import { PLUGIN_VERSION, type UpdateResult } from './types.js';

const PACKAGE_NAME = 'dsh-backup-rescue';
const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const MAX_LOG_LINES = 60;

export interface LatestVersionInfo {
  version: string;
  publishTime?: string;
}

/** 本插件的安装目录（…/node_modules/dsh-backup-rescue 或工作区目录）。 */
export function installedPluginDir(): string {
  return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
}

/** 由插件目录推导 profile 目录（node_modules 的上一级）。 */
export function profileDirOf(pluginDir: string): string {
  const parent = path.dirname(pluginDir);
  return path.basename(parent).toLowerCase() === 'node_modules' ? path.dirname(parent) : pluginDir;
}

/** 读某个目录下 package.json 的版本号。 */
function readPackageVersion(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** 查 npm registry 上的最新版本。 */
export async function fetchLatestVersion(timeoutMs = 20000): Promise<LatestVersionInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(REGISTRY_LATEST, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const data = (await response.json()) as { version?: string; time?: Record<string, string> };
    if (!data.version) throw new Error('npm registry response has no version field');
    return { version: data.version, publishTime: data.time?.[data.version] };
  } finally {
    clearTimeout(timer);
  }
}

interface CommandResult {
  ok: boolean;
  output: string;
}

/** 跑一个外部命令（Windows 下走 shell，方便调用 npm.cmd / pnpm.cmd）。 */
function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
        if (error) {
          const reason = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? '命令超时' : String(error.message ?? error);
          resolve({ ok: false, output: output ? `${output}\n[exit] ${reason}` : `[exit] ${reason}` });
          return;
        }
        resolve({ ok: true, output });
      },
    );
  });
}

/** 简单 semver 比较（够用即可）：a > b 返回 1，a === b 返回 0，a < b 返回 -1。 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  // 同号时预发布版更小（0.3.3-beta < 0.3.3），够用
  const preA = a.includes('-');
  const preB = b.includes('-');
  if (preA !== preB) return preA ? -1 : 1;
  return 0;
}

interface PackageManager {
  label: string;
  command: string;
  args: string[];
}

/**
 * 找 dsh-runtimes 里自带的 node + pnpm（DSH 安装时带的那份）。
 * 布局：<dshHome>/dsh-runtimes/<runtime>/dependencies/{node,pnpm}/…
 */
function findBundledPnpm(dshHome: string, version: string, profileDir: string): PackageManager | null {
  const runtimesDir = path.join(dshHome, 'dsh-runtimes');
  if (!fs.existsSync(runtimesDir)) return null;
  let runtimeNames: string[] = [];
  try {
    runtimeNames = fs.readdirSync(runtimesDir);
  } catch {
    return null;
  }
  for (const runtimeName of runtimeNames) {
    const deps = path.join(runtimesDir, runtimeName, 'dependencies');
    const pnpmJs = path.join(deps, 'pnpm', 'bin', 'pnpm.mjs');
    if (!fs.existsSync(pnpmJs)) continue;
    const nodeExe = process.platform === 'win32'
      ? path.join(deps, 'node', 'bin', 'node.exe')
      : path.join(deps, 'node', 'bin', 'node');
    const runtimeNode = fs.existsSync(nodeExe) ? nodeExe : process.execPath;
    return {
      label: `pnpm (${runtimeName})`,
      command: runtimeNode,
      // --config.minimum-release-age=0：绕过 profile 的 24h 新版本限制（pnpm 11 支持 --config.<key>）
      // --save-exact：写死版本号，避免后续 pnpm install 又漂移到别的版本
      args: [pnpmJs, 'add', `${PACKAGE_NAME}@${version}`, '--save-exact', '--config.minimum-release-age=0', '-C', profileDir],
    };
  }
  return null;
}

/** npm 兜底。 */
function npmManager(version: string, profileDir: string): PackageManager {
  return {
    label: 'npm',
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install', `${PACKAGE_NAME}@${version}`, '--save-exact', '--no-audit', '--no-fund', '--prefix', profileDir],
  };
}

/**
 * profile 的 pnpm-workspace.yaml 里 `minimumReleaseAge: 1440` 会拒绝 24 小时内发布的新版本。
 * 这里把 `dsh-backup-rescue@<version>` 塞进 minimumReleaseAgeExclude，幂等、失败不影响主流程。
 */
export function ensureReleaseAgeExclude(profileDir: string, version: string): string | null {
  const yamlPath = path.join(profileDir, 'pnpm-workspace.yaml');
  if (!fs.existsSync(yamlPath)) return null;
  let text: string;
  try {
    text = fs.readFileSync(yamlPath, 'utf8');
  } catch {
    return null;
  }
  const entry = `${PACKAGE_NAME}@${version}`;
  if (!/minimumReleaseAge\s*:/.test(text)) return null;
  if (text.includes(entry)) return null;

  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^minimumReleaseAgeExclude\s*:/.test(line));
  if (headerIndex === -1) {
    // 没有 exclude 列表就补一个空的（放在 minimumReleaseAge 行之后）
    const ageIndex = lines.findIndex((line) => /^minimumReleaseAge\s*:/.test(line));
    if (ageIndex === -1) return null;
    lines.splice(ageIndex + 1, 0, 'minimumReleaseAgeExclude:', `  - ${entry}`);
  } else {
    // 找到该列表的最后一行（缩进的 - 项）
    let insertAt = headerIndex + 1;
    while (insertAt < lines.length && (/^\s+-\s/.test(lines[insertAt]) || lines[insertAt].trim() === '')) {
      if (lines[insertAt].trim() === '') break;
      insertAt += 1;
    }
    lines.splice(insertAt, 0, `  - ${entry}`);
  }
  try {
    fs.writeFileSync(yamlPath, lines.join('\n'), 'utf8');
    return yamlPath;
  } catch {
    return null;
  }
}

export interface BackupAndUpdateOptions {
  dshHome: string;
  profileDir: string;
  profileName: string;
  /** 备份输出根目录，默认 <dshHome>/dsh-backup-rescue/exports。 */
  backupDir?: string;
  /** 是否先做一般备份（默认 true）。 */
  backup?: boolean;
  password?: string;
  /** 已经是最新版本时是否仍强制重装。 */
  force?: boolean;
  /** 超时（毫秒），默认 5 分钟。 */
  timeoutMs?: number;
}

/**
 * 一键备份并更新。
 *
 * 顺序：一般备份 → 查 npm 最新版 → （必要时）改 pnpm-workspace 白名单 → 安装 → 校验版本。
 * 备份失败直接终止（没有兜底就不动插件）；更新失败时备份已经留在磁盘上，用户可随时恢复。
 */
export async function backupAndUpdate(options: BackupAndUpdateOptions): Promise<UpdateResult> {
  const log: string[] = [];
  const pluginDir = installedPluginDir();
  const profileDir = options.profileDir || profileDirOf(pluginDir);
  const backupDir = options.backupDir;
  const oldVersion = readPackageVersion(pluginDir) ?? PLUGIN_VERSION;
  const push = (line: string): void => {
    if (log.length < MAX_LOG_LINES) log.push(line);
  };

  let backupPath: string | undefined;
  let backupFolder: string | undefined;

  // ---- 1. 先备份 ----
  if (options.backup !== false) {
    try {
      const result = await createBackup({
        dshHome: options.dshHome,
        profileDir,
        profileName: options.profileName,
        backupDir,
        password: options.password,
      });
      backupPath = result.archive;
      backupFolder = result.folder;
      push(`backup: ${result.archive} (${result.fileCount} files, ${result.totalBytes} bytes)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      push(`backup failed: ${message}`);
      return {
        ok: false,
        updated: false,
        oldVersion,
        newVersion: oldVersion,
        message: `备份失败，已取消更新（不会在没有备份的情况下动插件）：${message}`,
        error: message,
        log,
      };
    }
  } else {
    push('backup: skipped (backup=false)');
  }

  // ---- 2. 查最新版本 ----
  let latestVersion: string;
  try {
    const info = await fetchLatestVersion();
    latestVersion = info.version;
    push(`registry: latest=${info.version}${info.publishTime ? ` (${info.publishTime})` : ''}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    push(`registry query failed: ${message}`);
    return {
      ok: false,
      updated: false,
      oldVersion,
      newVersion: oldVersion,
      backupPath,
      backupFolder,
      message: `已备份，但查询 npm 最新版本失败：${message}`,
      error: message,
      log,
    };
  }

  push(`installed: ${pluginDir} (v${oldVersion})`);

  // 已经不比本地新时不动插件（避免把开发中的新版降级成 registry 上的旧版）
  if (compareVersions(latestVersion, oldVersion) <= 0 && options.force !== true) {
    return {
      ok: true,
      updated: false,
      oldVersion,
      newVersion: oldVersion,
      latestVersion,
      backupPath,
      backupFolder,
      message: `本地已是 ${oldVersion}，npm 上最新为 ${latestVersion}，未做任何安装。备份已保存在：${backupPath ?? '（未备份）'}`,
      log,
    };
  }

  // ---- 3. 绕过 24h 新版本限制 ----
  const patched = ensureReleaseAgeExclude(profileDir, latestVersion);
  if (patched) push(`patched: ${patched} → minimumReleaseAgeExclude += ${PACKAGE_NAME}@${latestVersion}`);

  // ---- 4. 安装 ----
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const managers: PackageManager[] = [];
  const bundled = findBundledPnpm(options.dshHome, latestVersion, profileDir);
  if (bundled) managers.push(bundled);
  managers.push(npmManager(latestVersion, profileDir));

  for (const manager of managers) {
    push(`install: ${manager.label} → ${manager.command} ${manager.args.join(' ')}`);
    const result = await runCommand(manager.command, manager.args, profileDir, timeoutMs);
    push(`install(${manager.label}): ${result.ok ? 'ok' : 'failed'}`);
    if (result.output) {
      for (const line of result.output.split(/\r?\n/).slice(-15)) {
        if (line.trim()) push(`  ${line.trim()}`);
      }
    }
    const nowVersion = readPackageVersion(pluginDir);
    if (result.ok && nowVersion === latestVersion) {
      return {
        ok: true,
        updated: true,
        oldVersion,
        newVersion: nowVersion,
        latestVersion,
        backupPath,
        backupFolder,
        message: `已从 ${oldVersion} 更新到 ${nowVersion}。备份在：${backupPath ?? '（未备份）'}。请重启 DSH 使新版本生效（设置页刷新后仍显示旧版本是正常的）。`,
        log,
      };
    }
    if (!result.ok) continue;
    push(`verify: 安装后版本仍是 ${nowVersion ?? '未知'}，继续尝试下一种安装方式`);
  }

  const afterVersion = readPackageVersion(pluginDir) ?? oldVersion;
  return {
    ok: false,
    updated: false,
    oldVersion,
    newVersion: afterVersion,
    latestVersion,
    backupPath,
    backupFolder,
    message: `备份已完成，但自动更新失败（当前 ${afterVersion}，目标 ${latestVersion}）。请看日志手动处理；备份文件可以直接恢复。`,
    error: 'update-failed',
    log,
  };
}
