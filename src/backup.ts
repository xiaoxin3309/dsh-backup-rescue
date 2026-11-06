/**
 * DSH Backup Plugin - 备份核心
 *
 * 设计要点
 * - 作用域是「整个 $DSH_HOME」，不是单个 profile：profiles/、storages/、skills/、
 *   dsh-config-manager/（vault、rollback-points、exports）都要一起带走，否则恢复
 *   出来的实例缺插件安装状态与凭据。
 * - 大体积且可重建的目录（node_modules、dsh-runtimes、web-login、speech-to-text、
 *   cache、telemetry）默认跳过，可用选项放开。
 * - ZIP 内根目录写 `DSH-MANIFEST.json`，记录逐文件 SHA-256 与大小，供恢复前校验。
 * - 给密码时不加密单个条目，而是把整包 ZIP 封装成 `.zip.enc`（0.4.1 起为 DSHBK002），
 *   头部为 MAGIC + salt + iv + authTag，恢复端一次解密即可。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type AdmZipType from 'adm-zip';
import {
  ENC_MAGIC,
  ENC_MAGIC_V1,
  ENC_PBKDF2_ITERATIONS,
  MANIFEST_NAME,
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND_DIR,
  PLUGIN_VERSION,
  type BackupOptions,
  type BackupEntry,
  type BackupKind,
  type CollectedFile,
  type BackupManifest,
  type BackupResult,
  type BackupListItem,
  type FullBackupOptions,
  type FullBackupResult,
  type PluginInventoryEntry,
  type WorkspaceRootEntry,
  type Logger,
} from './types.js';

// Re-export for restore.ts consumers
export { MANIFEST_NAME, type BackupManifest };

/**
 * adm-zip 惰性加载。
 *
 * 历史故障（0.3.2 实测）：profile 用 `link:` 装本插件时，插件目录不会跟着跑
 * `npm install`，于是 lib/backup.js 顶层的 `import AdmZip from 'adm-zip'` 让整个
 * 插件在 Loader 里 ERR_MODULE_NOT_FOUND，profiles 报 "did not activate
 * backup-plugin"。改成运行时按需 require 后，依赖缺失只影响 ZIP 读写，
 * 插件本身仍能激活并给出可执行的修复提示。
 */
const nodeRequire = createRequire(import.meta.url);
let zipCtor: typeof AdmZipType | null = null;

/** 取 adm-zip 构造函数；缺失时抛出带修复命令的错误。 */
function Zip(): typeof AdmZipType {
    if (zipCtor) return zipCtor;
    try {
        zipCtor = nodeRequire('adm-zip') as typeof AdmZipType;
        return zipCtor;
    }
    catch (error) {
        throw new Error(`adm-zip is not installed for this plugin (${fileURLToPath(import.meta.url)}). `
            + 'Run `npm install --omit=dev` inside the dsh-backup-rescue directory, then reload the plugin. '
            + `Original error: ${String(error)}`);
    }
}

/**
 * 任何层级都跳过的目录名（缓存、依赖、锁、临时目录）。
 *
 * 这里只放「放在哪里都该跳过」的名字。像 `web-login`、`speech-to-text` 这种是
 * $DSH_HOME 顶层的大目录，但同名目录也可能是 `skills/web-login` 这类真正要备份的
 * 内容 —— 那类名字只能按「顶层」判定，见 TOP_LEVEL_SKIP_DIR_NAMES。
 */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.cache',
  'cache',
  'logs',
  'log',
  'tmp',
  'temp',
  'locks',
  'lock',
  'running',
  'telemetry',
  'exports',
]);

/** 仅当位于 $DSH_HOME 顶层时才跳过（体积大且可重建）。 */
const TOP_LEVEL_SKIP_DIR_NAMES = new Set([
  'dsh-runtimes',
  'web-login',
  'speech-to-text',
  'dsh-market',
  '.dsh-market',
]);

/** 目录名里出现这些片段就跳过（快照类目录）。 */
const SKIP_DIR_FRAGMENTS = ['snapshot', '.bak', '.old', '.trash'];

/** 文件名后缀跳过。 */
const SKIP_FILE_SUFFIXES = ['.log', '.tmp'];

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * 对已经读进内存的内容算 SHA-256。
 *
 * 刻意不在扫描阶段单独读盘算哈希：DSH 运行期间 `storages/` 下的文件会被持续写入，
 * 扫描时算一次、打包时再读一次，两次内容不同就会在恢复端报 checksum mismatch。
 * 现在「读进内存的那一份字节」就是进包的那一份，哈希与内容天然一致。
 */
function sha256Content(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function shouldSkipDir(name: string, rel: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_DIR_NAMES.has(lower)) return true;
  // 顶层判定：`skills/web-login` 要留，`$DSH_HOME/web-login` 要跳。
  if (!rel.includes('/') && TOP_LEVEL_SKIP_DIR_NAMES.has(lower)) return true;
  return SKIP_DIR_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function shouldSkipFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  return /\.bak[-.]\d+$/.test(lower);
}

interface WalkResult {
  files: CollectedFile[];
  skipped: string[];
}

/**
 * 归档里“工作区文件”的顶层前缀。
 *
 * 工作区目录不在 `$DSH_HOME` 下，所以先按 `__workspaces__/<id>/<相对路径>` 收进同一个 zip，
 * 恢复时再按清单里的 `workspaceRoots[].path`（会先经过路径改写）搬回真实位置。
 */
export const WORKSPACE_ARCHIVE_PREFIX = '__workspaces__/';

export interface WorkspaceRoot {
  id: string;
  name: string;
  /** 原始绝对路径。 */
  path: string;
}

/** 从 `storages/workspace.json` 读出登记的工作区（只保留存在的绝对路径目录）。 */
export function listWorkspaceRoots(dshHome: string): WorkspaceRoot[] {
  const file = path.join(dshHome, 'storages', 'workspace.json');
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const table = parsed?.tables?.workspaces;
  if (!table || typeof table !== 'object') return [];
  const roots: WorkspaceRoot[] = [];
  for (const [id, value] of Object.entries<any>(table)) {
    const rawPath = typeof value?.path === 'string' ? value.path : '';
    if (!rawPath || !path.isAbsolute(rawPath)) continue;
    if (!fs.existsSync(rawPath)) continue;
    try {
      if (!fs.statSync(rawPath).isDirectory()) continue;
    } catch {
      continue;
    }
    roots.push({ id, name: typeof value?.title === 'string' && value.title ? value.title : path.basename(rawPath) || id, path: rawPath });
  }
  return roots;
}

interface WorkspaceCollection {
  files: CollectedFile[];
  /** 归档内路径 → 磁盘上的真实来源（createBackup 打包时按它读文件）。 */
  sources: Map<string, string>;
  roots: WorkspaceRootEntry[];
  skipped: string[];
}

/**
 * 收集工作区里的文件。
 *
 * 跳过 `node_modules`/`cache`/`logs`/`tmp` 之类可重建目录、`*snapshot*`/`*.bak` 这类快照目录，
 * 以及 `.log`/`.tmp`/`*.bak-<数字>` 文件——和 `$DSH_HOME` 的规则保持一致，避免备份把
 * 工作区里的构建产物整个搬走。落在 `$DSH_HOME` 内部的工作区会被跳过（已经在主备份里）。
 */
export function collectWorkspaceFiles(dshHome: string, roots: WorkspaceRoot[], log?: Logger): WorkspaceCollection {
  const collection: WorkspaceCollection = { files: [], sources: new Map(), roots: [], skipped: [] };
  const homeLower = path.resolve(dshHome).toLowerCase();

  for (const root of roots) {
    const rootPath = path.resolve(root.path);
    const insideHome = rootPath.toLowerCase() === homeLower || rootPath.toLowerCase().startsWith(`${homeLower}${path.sep}`);
    if (insideHome) {
      collection.skipped.push(`${rootPath} (inside DSH home)`);
      continue;
    }
    const prefix = `${WORKSPACE_ARCHIVE_PREFIX}${root.id}/`;
    const files: CollectedFile[] = [];
    let totalBytes = 0;

    const walk = (absDir: string, relDir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch (error) {
        collection.skipped.push(`${relDir || rootPath} (unreadable: ${String(error)})`);
        return;
      }
      for (const entry of entries) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        const lower = entry.name.toLowerCase();
        const abs = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIR_NAMES.has(lower)) {
            collection.skipped.push(`${rootPath}/${rel}/`);
            continue;
          }
          if (SKIP_DIR_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
            collection.skipped.push(`${rootPath}/${rel}/`);
            continue;
          }
          walk(abs, rel);
          continue;
        }
        if (entry.isSymbolicLink()) {
          // 工作区里的符号链接：只收文件，目录链接跳过（避免把别处的整棵树卷进来）
          try {
            if (fs.statSync(abs).isDirectory()) {
              collection.skipped.push(`${rootPath}/${rel} (linked dir)`);
              continue;
            }
          } catch {
            collection.skipped.push(`${rootPath}/${rel} (dangling link)`);
            continue;
          }
        }
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (SKIP_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
          collection.skipped.push(`${rootPath}/${rel}`);
          continue;
        }
        if (/\.bak[-.]\d+$/i.test(lower)) {
          collection.skipped.push(`${rootPath}/${rel}`);
          continue;
        }
        try {
          const stat = fs.statSync(abs);
          const archivePath = `${prefix}${rel}`;
          files.push({ path: archivePath, size: stat.size });
          collection.sources.set(archivePath, abs);
          totalBytes += stat.size;
        } catch (error) {
          collection.skipped.push(`${rootPath}/${rel} (unreadable: ${String(error)})`);
        }
      }
    };

    walk(rootPath, '');
    collection.files.push(...files);
    collection.roots.push({
      id: root.id,
      name: root.name,
      path: rootPath,
      archivePrefix: prefix,
      fileCount: files.length,
      totalBytes,
    });
    if (log) log(`workspace packed: ${rootPath} (${files.length} files, ${totalBytes} bytes)`);
  }

  return collection;
}

/**
 * 扫出各 profile 已安装的插件（只读 `node_modules/<pkg>/package.json` 的 name/version）。
 *
 * 一般备份不打包 `node_modules`（几百 MB、且能由 lockfile 重建），但恢复时必须知道
 * 「原来装了什么」，否则用户会看到 profiles 里有插件记录、插件代码却不在。
 * 这里只读包名与版本，成本是每个包一次小文件读取。
 */
export function collectPluginInventory(dshHome: string): PluginInventoryEntry[] {
  const profilesDir = path.join(dshHome, 'profiles');
  const inventory: PluginInventoryEntry[] = [];
  let profiles: fs.Dirent[];
  try {
    profiles = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return inventory;
  }

  for (const profile of profiles) {
    if (!profile.isDirectory()) continue;
    const modulesDir = path.join(profilesDir, profile.name, 'node_modules');
    let entries: string[];
    try {
      entries = fs.readdirSync(modulesDir);
    } catch {
      continue;
    }
    const packages: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith('.')) continue; // .bin / .pnpm / .modules.yaml
      if (entry.startsWith('@')) {
        try {
          for (const child of fs.readdirSync(path.join(modulesDir, entry))) {
            packages.push(`${entry}/${child}`);
          }
        } catch {
          /* 忽略读不到的 scope */
        }
        continue;
      }
      packages.push(entry);
    }
    for (const name of packages) {
      try {
        const raw = fs.readFileSync(path.join(modulesDir, name, 'package.json'), 'utf8');
        const parsed = JSON.parse(raw) as { name?: string; version?: string };
        if (!parsed.version) continue;
        inventory.push({ profile: profile.name, name: parsed.name ?? name, version: parsed.version });
      } catch {
        /* 没有 package.json（或被改坏）就跳过 */
      }
    }
  }
  return inventory.sort((left, right) => left.profile.localeCompare(right.profile) || left.name.localeCompare(right.name));
}

/**
 * 收集 $DSH_HOME 下需要进包的普通文件。符号链接只跟随文件，目录级链接跳过，
 * 避免把 profile 里 `link:` 安装的工作区整棵拷进备份。
 */
export function collectFiles(options: BackupOptions): WalkResult {
  const dshHome = path.resolve(options.dshHome);
  const extraExcludes = (options.excludePatterns ?? []).map((entry) => toPosix(entry).replace(/^\.?\//, ''));
  const files: CollectedFile[] = [];
  const skipped: string[] = [];

  const isExtraExcluded = (rel: string): boolean =>
    extraExcludes.some((pattern) => rel === pattern || rel.startsWith(`${pattern}/`));

  const walk = (absDir: string, relDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (error) {
      skipped.push(`${relDir || '.'} (unreadable: ${String(error)})`);
      return;
    }

    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isExtraExcluded(rel)) {
        skipped.push(rel);
        continue;
      }

      const abs = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        // node_modules 就是“插件代码本身”：一般备份默认跳过，勾了 includeNodeModules 才整体带上
        if (entry.name.toLowerCase() === 'node_modules') {
          if (options.includeNodeModules === true) walk(abs, rel);
          else skipped.push(`${rel}/`);
          continue;
        }
        if (shouldSkipDir(entry.name, rel)) {
          skipped.push(`${rel}/`);
          continue;
        }
        if (options.includeSessions === false && (rel === 'sessions' || rel.startsWith('sessions/'))) {
          skipped.push(`${rel}/`);
          continue;
        }
        if (options.includeAttachments === false && (rel === 'attachments' || rel.startsWith('attachments/'))) {
          skipped.push(`${rel}/`);
          continue;
        }
        walk(abs, rel);
        continue;
      }

      if (entry.isSymbolicLink()) {
        // 只收文件级链接的内容，目录级链接（工作区 link: 安装）整体跳过。
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          skipped.push(`${rel} (dangling link)`);
          continue;
        }
        if (stat.isDirectory()) {
          skipped.push(`${rel} (linked dir)`);
          continue;
        }
      } else if (!entry.isFile()) {
        continue;
      }

      if (shouldSkipFile(entry.name)) {
        skipped.push(rel);
        continue;
      }

      try {
        const stat = fs.statSync(abs);
        files.push({ path: rel, size: stat.size });
      } catch (error) {
        skipped.push(`${rel} (unreadable: ${String(error)})`);
      }
    }
  };

  walk(dshHome, '');
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, skipped };
}

/**
 * 整包加密（0.4.1 起为 DSHBK002）。
 *
 * 布局：`magic(8) | salt(16) | iv(16) | hmac(32) | 密文`
 *  - 密钥：PBKDF2-HMAC-SHA256(password, salt, 200000) 出 64 字节，
 *    前 32 字节做 AES-256-CBC 密钥，后 32 字节做 HMAC-SHA256 密钥；
 *  - 认证：HMAC 覆盖 `magic | salt | iv | 密文`（encrypt-then-MAC）；
 *  - 为什么不用 GCM：独立恢复脚本只有 Windows 自带的 PowerShell 5.1（.NET Framework），
 *    那里既没有 AesGcm 也没有 scrypt，而 PBKDF2 / AES-CBC / HMAC 全都有。
 *    旧格式 DSHBK001（scrypt + AES-256-GCM）仍能解密，见 decryptArchive()。
 */
export function encryptArchive(content: Buffer, password: string): Buffer {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(password, salt, ENC_PBKDF2_ITERATIONS, 64, 'sha256');
  const encKey = derived.subarray(0, 32);
  const macKey = derived.subarray(32, 64);
  const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const body = Buffer.concat([cipher.update(content), cipher.final()]);
  const magic = Buffer.from(ENC_MAGIC, 'ascii');
  const mac = crypto.createHmac('sha256', macKey).update(magic).update(salt).update(iv).update(body).digest();
  return Buffer.concat([magic, salt, iv, mac, body]);
}

/** 解密 `.zip.enc`：同时支持 DSHBK002（当前）与 DSHBK001（0.3.x–0.4.0）。 */
export function decryptArchive(content: Buffer, password: string): Buffer {
  if (content.length > ENC_MAGIC_V1.length && content.subarray(0, ENC_MAGIC_V1.length).equals(Buffer.from(ENC_MAGIC_V1, 'ascii'))) {
    return decryptArchiveV1(content, password);
  }
  const head = ENC_MAGIC.length;
  if (content.length < head + 16 + 16 + 32) throw new Error('archive too short to be a DSH backup');
  if (!content.subarray(0, head).equals(Buffer.from(ENC_MAGIC, 'ascii'))) throw new Error('not a DSH backup encrypted archive');
  const salt = content.subarray(head, head + 16);
  const iv = content.subarray(head + 16, head + 32);
  const mac = content.subarray(head + 32, head + 64);
  const body = content.subarray(head + 64);
  const derived = crypto.pbkdf2Sync(password, salt, ENC_PBKDF2_ITERATIONS, 64, 'sha256');
  const encKey = derived.subarray(0, 32);
  const macKey = derived.subarray(32, 64);
  const magic = content.subarray(0, head);
  const expected = crypto.createHmac('sha256', macKey).update(magic).update(salt).update(iv).update(body).digest();
  if (expected.length !== mac.length || !crypto.timingSafeEqual(expected, mac)) {
    throw new Error('wrong password (HMAC mismatch)');
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** 旧格式（0.3.x–0.4.0）：scrypt + AES-256-GCM。 */
function decryptArchiveV1(content: Buffer, password: string): Buffer {
  const head = ENC_MAGIC_V1.length;
  if (content.length < head + 16 + 12 + 16) throw new Error('archive too short to be a DSH backup');
  const salt = content.subarray(head, head + 16);
  const iv = content.subarray(head + 16, head + 28);
  const tag = content.subarray(head + 28, head + 44);
  const body = content.subarray(head + 44);
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** 读取任意备份文件（.zip 或 .zip.enc）的清单。 */
export function readManifest(backupPath: string, password?: string): BackupManifest {
  const zip = openArchive(backupPath, password);
  const entry = zip.getEntry(MANIFEST_NAME);
  if (!entry) throw new Error(`manifest missing: ${MANIFEST_NAME}`);
  return JSON.parse(zip.readAsText(entry)) as BackupManifest;
}

/** 打开备份（必要时先解密到内存）。 */
export function openArchive(backupPath: string, password?: string): AdmZipType {
  const raw = fs.readFileSync(backupPath);
  if (backupPath.toLowerCase().endsWith('.enc')) {
    if (!password) throw new Error('this backup is encrypted; a password is required');
    return new (Zip())(decryptArchive(raw, password));
  }
  return new (Zip())(raw);
}

/** 创建一份完整备份。 */
export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  const dshHome = path.resolve(options.dshHome);
  if (!fs.existsSync(dshHome)) throw new Error(`dshHome not found: ${dshHome}`);
  if (options.password && options.password.length < 4) {
    throw new Error('password must be at least 4 characters');
  }

  const profileName = options.profileName ?? 'desktop';
  const profileDir = options.profileDir ?? path.join(dshHome, 'profiles', profileName);
  const backupDir = path.resolve(options.backupDir ?? path.join(dshHome, 'dsh-backup-rescue', 'exports'));

  const { files, skipped } = collectFiles({ ...options, dshHome });
  // 工作区不在 $DSH_HOME 里，勾了 includeWorkspaces 才从 storages/workspace.json 读出路径并收集
  const workspaceCollection =
    options.includeWorkspaces === true ? collectWorkspaceFiles(dshHome, listWorkspaceRoots(dshHome)) : null;
  if (workspaceCollection && workspaceCollection.files.length > 0) {
    files.push(...workspaceCollection.files);
    skipped.push(...workspaceCollection.skipped);
  }
  if (files.length === 0) throw new Error('nothing to back up: no files matched');

  // 边读边打包：进包的那份字节同时用来算哈希，避免「扫描时算一次、打包时再读一次」
  // 造成的 checksum mismatch（DSH 运行中 storages/ 一直在写）。
  const zip = new (Zip())();
  const entries: BackupEntry[] = [];
  for (const file of files) {
    let content: Buffer;
    try {
      const source = workspaceCollection?.sources.get(file.path) ?? path.join(dshHome, file.path);
      content = fs.readFileSync(source);
    } catch (error) {
      skipped.push(`${file.path} (read failed: ${String(error)})`);
      continue;
    }
    zip.addFile(toPosix(file.path), content);
    entries.push({ path: file.path, sha256: sha256Content(content), size: content.length });
  }
  if (entries.length === 0) throw new Error('nothing to back up: every file failed to read');

  const totalBytes = entries.reduce((sum, file) => sum + file.size, 0);
  const workspaceRoots = (workspaceCollection?.roots ?? []).map((root) => ({
    ...root,
    fileCount: entries.filter((entry) => entry.path.startsWith(root.archivePrefix)).length,
    totalBytes: entries.filter((entry) => entry.path.startsWith(root.archivePrefix)).reduce((sum, entry) => sum + entry.size, 0),
  }));
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    pluginVersion: PLUGIN_VERSION,
    createdAt: new Date().toISOString(),
    dshHome,
    profileName,
    profileDir,
    includeSecrets: options.includeSecrets === true,
    includedSessions: options.includeSessions !== false,
    includedAttachments: options.includeAttachments !== false,
    encrypted: Boolean(options.password),
    // 一般备份默认不打包 node_modules（插件代码本身），勾了 includeNodeModules 才带
    includedNodeModules: options.includeNodeModules === true,
    includedWorkspaces: workspaceRoots.length > 0,
    workspaceRoots,
    plugins: collectPluginInventory(dshHome),
    fileCount: entries.length,
    totalBytes,
    files: entries,
    skipped,
    runtime: { node: process.version, platform: process.platform },
  };

  zip.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `dsh-backup-${stamp}`;
  // 每份备份独占一个与自己同名的文件夹：<backupDir>/normal/<baseName>/
  // 里面放 <baseName>.zip 与可双击恢复的同名 .bat，方便整份拷走/归档。
  const folder = prepareBackupFolder(backupDir, 'normal', baseName);
  const zipPath = path.join(folder, `${baseName}.zip`);
  zip.writeZip(zipPath);

  if (options.password) {
    const encPath = `${zipPath}.enc`;
    fs.writeFileSync(encPath, encryptArchive(fs.readFileSync(zipPath), options.password));
    fs.unlinkSync(zipPath);
    emitRestoreScripts(folder, encPath);
    return {
      ok: true,
      path: encPath,
      archive: encPath,
      folder,
      restoreBat: oneClickBatOrUndefined(encPath),
      encrypted: true,
      fileCount: entries.length,
      totalBytes,
      manifest,
    };
  }

  emitRestoreScripts(folder, zipPath);
  return {
    ok: true,
    path: zipPath,
    archive: zipPath,
    folder,
    restoreBat: oneClickBatOrUndefined(zipPath),
    encrypted: false,
    fileCount: entries.length,
    totalBytes,
    manifest,
  };
}

/**
 * 为一份备份准备独占文件夹：`<backupDir>/<normal|full>/<baseName>/`。
 *
 * 一般备份与全量备份分别落在 normal/ 与 full/ 两个目录下，互不混杂；
 * 每份备份再单独占一个与压缩包同名的子文件夹，把 zip 和它的恢复脚本放在一起，
 * 用户可以直接整份拷贝/归档，也不会出现“一堆 restore-xxx.bat 横在目录里”。
 */
export function prepareBackupFolder(backupDir: string, kind: BackupKind, baseName: string): string {
  const folder = path.join(backupDir, BACKUP_KIND_DIR[kind], baseName);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

/** 某份备份对应的“双击即恢复”脚本名（与压缩包同主名，扩展名 .bat）。 */
export function restoreBatPath(archivePath: string): string {
  const stem = path.basename(archivePath).replace(/\.(zip|zip\.enc)$/i, '');
  return path.join(path.dirname(archivePath), `${stem}.bat`);
}

/** 该备份的一键恢复 .bat 是否存在；不存在时返回 undefined（供结果对象用）。 */
function oneClickBatOrUndefined(archivePath: string): string | undefined {
  const bat = restoreBatPath(archivePath);
  return fs.existsSync(bat) ? bat : undefined;
}

/**
 * 把恢复器铺到某份备份自己的文件夹里：
 *  - restore.bat / restore.sh：通用交互式恢复器（可手动指定任意备份）
 *  - <备份同名>.bat：双击即恢复本份备份（与 zip 同目录同名，版本一一对应）
 *
 * 恢复器是纯脚本，不依赖 DSH 运行、也不依赖本插件；因此直接复用 templates/
 * 里的模板原文。写失败只意味着少了个便利入口，绝不能影响备份结果本身。
 */
export function emitRestoreScripts(folderDir: string, archivePath: string): string[] {
  const written: string[] = [];
  try {
    const templatesDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'templates');
    const targets: Array<[string, string, number]> = [
      ['restore.bat', path.join(folderDir, 'restore.bat'), 0o644],
      ['restore.sh', path.join(folderDir, 'restore.sh'), 0o755],
    ];
    for (const [source, destination, mode] of targets) {
      const sourcePath = path.join(templatesDir, source);
      if (!fs.existsSync(sourcePath)) continue;
      const raw = fs.readFileSync(sourcePath);
      if (source === 'restore.bat') {
        // .bat 必须是 CRLF：模板在仓库里用 LF 保存，而 cmd.exe 处理 LF-only 的
        // 批处理会中途把行切错（实测会打印 "'OT' is not recognized ..." 后立刻退出，
        // 用户看到的现象就是“窗口一闪就没了”）。也绝不能加 BOM、不能写非 ASCII：
        // cmd 会按当前代码页重新读文件，多字节字符会把解析器带到行中间（0.4.1 实测）。
        const crlf = raw.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
        fs.writeFileSync(destination, Buffer.from(crlf, 'utf8'));
      } else {
        // .sh 保持 LF（CRLF 会让 macOS/Linux 的 bash 报 $'\r': command not found）
        fs.writeFileSync(destination, raw);
      }
      try {
        fs.chmodSync(destination, mode);
      } catch {
        /* chmod 在 Windows 上是空操作 */
      }
      written.push(destination);
    }

    // 与压缩包同名的 .bat：只恢复这一份备份。名字与 zip 完全对应，
    // 用户看到 dsh-backup-<时间戳>.zip 就知道该双击同一个名字的 .bat。
    const archiveName = path.basename(archivePath);
    const oneClick = restoreBatPath(archivePath);
    const body = [
      '@echo off',
      'rem Restore this backup: calls restore.bat next to it and passes this archive.',
      `call "%~dp0restore.bat" "%~dp0${archiveName}"`,
      '',
    ].join('\r\n');
    // 纯 ASCII + CRLF，不加 BOM：cmd.exe 才不会被多字节字符带偏。
    fs.writeFileSync(oneClick, Buffer.from(body, 'utf8'));
    written.push(oneClick);
  } catch {
    /* 恢复器是附加产物，失败不能影响备份结果 */
  }
  return written;
}

/** 只要文件名像备份归档（.zip / .zip.enc）。 */
function isArchiveName(name: string): boolean {
  return /^dsh-backup-.*\.(zip|zip\.enc)$/i.test(name);
}

/** 从路径/文件名推断备份类型。 */
function inferKind(filePath: string, name: string): BackupKind {
  const normalized = toPosix(filePath).toLowerCase();
  if (normalized.includes(`/${BACKUP_KIND_DIR.full}/`) || name.toLowerCase().startsWith('dsh-backup-full-')) return 'full';
  return 'normal';
}

function buildListItem(full: string, name: string): BackupListItem {
  const stat = fs.statSync(full);
  const folder = path.dirname(full);
  const bat = restoreBatPath(full);
  return {
    path: full,
    name,
    size: stat.size,
    encrypted: name.toLowerCase().endsWith('.enc'),
    createdAt: stat.mtime.toISOString(),
    kind: inferKind(full, name),
    folder,
    restoreBat: fs.existsSync(bat) ? bat : null,
  };
}

/**
 * 列出备份，最新在前。
 *
 * 兼容三种布局：
 *  - 0.3.3 起：`<backupDir>/<normal|full>/<baseName>/<baseName>.zip`
 *  - 0.3.2 及更早：`<backupDir>/<baseName>.zip`（平铺）
 *  - 手工整理过的：任意一层子目录里的归档文件
 */
export function listBackups(backupDir: string): BackupListItem[] {
  if (!fs.existsSync(backupDir)) return [];
  const items: BackupListItem[] = [];

  const scan = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 只下钻两层：normal/full → 每份备份的同名文件夹
        if (depth < 2 && !entry.name.startsWith('.')) scan(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isArchiveName(entry.name)) continue;
      try {
        items.push(buildListItem(full, entry.name));
      } catch {
        /* 读不到的归档直接忽略 */
      }
    }
  };

  scan(backupDir, 0);
  return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.name.localeCompare(left.name));
}

/**
 * 即使全量备份也必须跳过的目录：
 *  - `exports`：备份仓库自己就在里面，带上会无限自我复制；
 *  - `.git` / `tmp` / `temp` / `locks` / `lock` / `running`：版本库与临时状态，恢复无意义。
 */
const FULL_BACKUP_ALWAYS_SKIP = new Set(['exports', '.git', 'tmp', 'temp', 'locks', 'lock', 'running']);

/** 全量备份目录清单（includeEverything=true 时加入）。 */
const FULL_BACKUP_EXTRA_DIRS = [
  'node_modules',
  'dsh-runtimes',
  'cache',
  'logs',
  'web-login',
  'speech-to-text',
  'dsh-market',
  '.dsh-market',
  'telemetry',
  'exports',
];

/**
 * 创建一份「完整备份」：把通常跳过的目录（node_modules、dsh-runtimes、cache、logs、
 * web-login、speech-to-text、dsh-market、telemetry）一起打进包。
 *
 * 适用于「卸载重装 DSH 后一键恢复」场景——备份里自带插件代码与运行时依赖，
 * 恢复后不需要联网重装任何东西。0.4.3 之前的版本有个 bug：`node_modules` 仍被
 * 无条件跳过，所以“完整备份”其实也没带插件；这里改由 FULL_BACKUP_ALWAYS_SKIP
 * 只排除 exports/.git/临时目录。
 *
 * 警告：体积可能极大（数 GB），仅在明确需要时使用。
 */
export async function createFullBackup(options: FullBackupOptions): Promise<FullBackupResult> {
  const dshHome = path.resolve(options.dshHome);
  if (!fs.existsSync(dshHome)) throw new Error(`dshHome not found: ${dshHome}`);
  if (options.password && options.password.length < 4) {
    throw new Error('password must be at least 4 characters');
  }

  const profileName = options.profileName ?? 'desktop';
  const profileDir = options.profileDir ?? path.join(dshHome, 'profiles', profileName);
  const backupDir = path.resolve(options.backupDir ?? path.join(dshHome, 'dsh-backup-rescue', 'exports'));

  // 收集文件：跳过内置的 SKIP_DIR_NAMES（node_modules 等），但加入 FULL_BACKUP_EXTRA_DIRS
  const dshHomeLower = dshHome.toLowerCase();
  const files: CollectedFile[] = [];
  const skipped: string[] = [];
  const includedExtraDirs: string[] = [];

  const walk = (absDir: string, relDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        const nameLower = entry.name.toLowerCase();

        // 常规跳过目录（node_modules/cache/logs…）；全量备份时除“必须永远跳过”的以外都带上
        if (SKIP_DIR_NAMES.has(nameLower)) {
          const keepInFull = options.includeEverything === true && !FULL_BACKUP_ALWAYS_SKIP.has(nameLower);
          if (!keepInFull) {
            skipped.push(`${rel}/`);
            continue;
          }
          if (!includedExtraDirs.includes(entry.name)) includedExtraDirs.push(entry.name);
        }

        // 顶层大目录：正常模式跳过，全量模式保留
        const isTopLevel = !rel.includes('/');
        if (isTopLevel && TOP_LEVEL_SKIP_DIR_NAMES.has(nameLower)) {
          if (options.includeEverything === true) {
            includedExtraDirs.push(entry.name);
            // 不跳过，继续递归
          } else {
            skipped.push(`${rel}/`);
            continue;
          }
        }

        // 快照类目录
        if (SKIP_DIR_FRAGMENTS.some((fragment) => nameLower.includes(fragment))) {
          skipped.push(`${rel}/`);
          continue;
        }

        // 会话/附件控制
        if (options.includeSessions === false && (rel === 'sessions' || rel.startsWith('sessions/'))) {
          skipped.push(`${rel}/`);
          continue;
        }
        if (options.includeAttachments === false && (rel === 'attachments' || rel.startsWith('attachments/'))) {
          skipped.push(`${rel}/`);
          continue;
        }

        walk(abs, rel);
        continue;
      }

      if (entry.isFile() || entry.isSymbolicLink()) {
        // 文件后缀跳过
        if (SKIP_FILE_SUFFIXES.some((suffix) => entry.name.toLowerCase().endsWith(suffix))) {
          skipped.push(entry.name);
          continue;
        }
        if (/\.(?:bak[-.]\d+|old|trash|tmp|log)$/i.test(entry.name)) {
          skipped.push(entry.name);
          continue;
        }

        try {
          const content = fs.readFileSync(abs);
          files.push({ path: rel, size: content.length });
        } catch {
          skipped.push(rel);
        }
      }
    }
  };

  walk(dshHome, '');

  // 工作区文件（不在 $DSH_HOME 里），勾了 includeWorkspaces 才收
  const workspaceCollection =
    options.includeWorkspaces === true ? collectWorkspaceFiles(dshHome, listWorkspaceRoots(dshHome)) : null;
  if (workspaceCollection && workspaceCollection.files.length > 0) {
    files.push(...workspaceCollection.files);
    skipped.push(...workspaceCollection.skipped);
  }

  if (files.length === 0) throw new Error('nothing to back up: no files matched');

  // 打包
  const zip = new (Zip())();
  const entries: BackupEntry[] = [];
  for (const file of files) {
    let content: Buffer;
    try {
      const source = workspaceCollection?.sources.get(file.path) ?? path.join(dshHome, file.path);
      content = fs.readFileSync(source);
    } catch {
      skipped.push(`${file.path} (read failed)`);
      continue;
    }
    zip.addFile(toPosix(file.path), content);
    entries.push({ path: file.path, sha256: sha256Content(content), size: content.length });
  }

  if (entries.length === 0) throw new Error('nothing to back up: every file failed to read');

  const totalBytes = entries.reduce((sum, f) => sum + f.size, 0);
  const workspaceRoots = (workspaceCollection?.roots ?? []).map((root) => ({
    ...root,
    fileCount: entries.filter((entry) => entry.path.startsWith(root.archivePrefix)).length,
    totalBytes: entries.filter((entry) => entry.path.startsWith(root.archivePrefix)).reduce((sum, entry) => sum + entry.size, 0),
  }));
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    pluginVersion: PLUGIN_VERSION,
    createdAt: new Date().toISOString(),
    dshHome,
    profileName,
    profileDir,
    includeSecrets: options.includeSecrets === true,
    includedSessions: options.includeSessions !== false,
    includedAttachments: options.includeAttachments !== false,
    encrypted: Boolean(options.password),
    // 全量备份把 node_modules 一起带走，恢复后不用联网重装插件
    includedNodeModules: options.includeEverything === true,
    includedWorkspaces: workspaceRoots.length > 0,
    workspaceRoots,
    plugins: collectPluginInventory(dshHome),
    fileCount: entries.length,
    totalBytes,
    files: entries,
    skipped,
    runtime: { node: process.version, platform: process.platform },
  };

  zip.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `dsh-backup-full-${stamp}`;
  // 全量备份单独落在 <backupDir>/full/<baseName>/，与一般备份互不混杂。
  const folder = prepareBackupFolder(backupDir, 'full', baseName);
  const zipPath = path.join(folder, `${baseName}.zip`);
  zip.writeZip(zipPath);

  if (options.password) {
    const encPath = `${zipPath}.enc`;
    fs.writeFileSync(encPath, encryptArchive(fs.readFileSync(zipPath), options.password));
    fs.unlinkSync(zipPath);
    emitRestoreScripts(folder, encPath);
    return {
      ok: true,
      path: encPath,
      archive: encPath,
      folder,
      restoreBat: oneClickBatOrUndefined(encPath),
      encrypted: true,
      fileCount: entries.length,
      totalBytes,
      manifest,
      includedExtraDirs,
      note: `完整备份完成。包含 ${includedExtraDirs.length} 个额外目录（${includedExtraDirs.join(', ') || '无'}），插件代码（node_modules）${(options.includeEverything === true ? '已' : '未')}打包。体积较大，恢复后无需重新安装依赖。`,
    };
  }

  emitRestoreScripts(folder, zipPath);
  return {
    ok: true,
    path: zipPath,
    archive: zipPath,
    folder,
    restoreBat: oneClickBatOrUndefined(zipPath),
    encrypted: false,
    fileCount: entries.length,
    totalBytes,
    manifest,
    includedExtraDirs,
    note: `完整备份完成。包含 ${includedExtraDirs.length} 个额外目录（${includedExtraDirs.join(', ') || '无'}），插件代码（node_modules）${(options.includeEverything === true ? '已' : '未')}打包。体积较大，恢复后无需重新安装依赖。`,
  };
}
