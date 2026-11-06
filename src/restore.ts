/**
 * DSH Backup Plugin - 恢复核心
 *
 * 流程（与 DSH-BACKUP.md 的设计保持一致，但落到整个 $DSH_HOME）：
 *   1. 打开备份（`.zip` 或 `.zip.enc`），读出 `DSH-MANIFEST.json`
 *   2. 逐条目比对 SHA-256，任何不一致都拒绝写入
 *   3. dryRun 时只返回「将要写入哪些文件」
 *   4. 否则先把被覆盖的现有文件复制到 `<target>/.backup-snapshot/<时间戳>/`，
 *      再解压写入，最后按清单复核哈希
 *
 * 注意：不做「删除备份中不存在的文件」，避免误删运行期生成的数据；
 * 需要干净还原时，用户应先把整个 $DSH_HOME 改名再恢复。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MANIFEST_NAME, readManifest, openArchive, WORKSPACE_ARCHIVE_PREFIX } from './backup.js';
import {
  type BackupManifest,
  type PathRewriteSummary,
  type RestoreOptions,
  type RestoreResult,
  type WorkspaceRestoreEntry,
} from './types.js';

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** 只有这些扩展名的文件才做路径改写（避免碰二进制）。 */
const REWRITE_EXTENSIONS = new Set([
  '.json', '.jsonl', '.yaml', '.yml', '.md', '.txt', '.js', '.mjs', '.cjs', '.ts',
  '.bat', '.sh', '.ps1', '.cfg', '.ini', '.toml', '.xml', '.csv', '.conf', '.properties', '.env',
]);

/** 单文件改写上限：再大基本不是配置，跳过更安全。 */
const REWRITE_MAX_BYTES = 8 * 1024 * 1024;

/** 把备份里记录的旧 home / 旧用户名根目录映射到恢复目标。 */
export function buildPathRewrites(manifest: BackupManifest, targetDir: string, enabled = true): Array<{ from: string; to: string }> {
  if (!enabled) return [];
  const oldHome = String(manifest.dshHome ?? '').trim().replace(/[\\/]+$/, '');
  const newHome = path.resolve(targetDir).replace(/[\\/]+$/, '');
  if (!oldHome || oldHome.toLowerCase() === newHome.toLowerCase()) return [];
  const pairs = [{ from: oldHome, to: newHome }];
  const oldRoot = path.dirname(oldHome);
  const newRoot = path.dirname(newHome);
  const oldRootIsRoot = oldRoot === path.parse(oldRoot).root;
  if (!oldRootIsRoot && oldRoot.toLowerCase() !== newRoot.toLowerCase()) {
    pairs.push({ from: oldRoot, to: newRoot });
  }
  // 长前缀优先：先换 C:\Users\old\.dsh 再换 C:\Users\old
  return pairs.sort((left, right) => right.from.length - left.from.length);
}

/** 在文本内容里替换路径（同时处理反斜杠与正斜杠两种写法）。 */
function rewriteBuffer(content: Buffer, relative: string, pairs: Array<{ from: string; to: string }>): { content: Buffer; replacements: number } {
  if (pairs.length === 0) return { content, replacements: 0 };
  if (!REWRITE_EXTENSIONS.has(path.extname(relative).toLowerCase())) return { content, replacements: 0 };
  if (content.length > REWRITE_MAX_BYTES) return { content, replacements: 0 };
  if (content.includes(0)) return { content, replacements: 0 };
  const text = content.toString('utf8');
  let next = text;
  let replacements = 0;
  for (const pair of pairs) {
    // 三种写法都要换：普通路径、JSON 里转义过的 `C:\\Users\\...`、以及正斜杠写法
    const variants: Array<[string, string]> = [
      [pair.from, pair.to],
      [pair.from.replace(/\\/g, '\\\\'), pair.to.replace(/\\/g, '\\\\')],
      [pair.from.replace(/\\/g, '/'), pair.to.replace(/\\/g, '/')],
    ];
    for (const [from, to] of variants) {
      if (!from) continue;
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      next = next.replace(new RegExp(escaped, 'gi'), () => {
        replacements += 1;
        return to;
      });
    }
  }
  if (replacements === 0) return { content, replacements: 0 };
  return { content: Buffer.from(next, 'utf8'), replacements };
}

/** 把一段路径按旧的 home/用户名映射改写成新路径。 */
export function rewritePathValue(value: string, pairs: Array<{ from: string; to: string }>): string {
  let next = value;
  for (const pair of pairs) {
    const variants: Array<[string, string]> = [
      [pair.from, pair.to],
      [pair.from.replace(/\\/g, '\\\\'), pair.to.replace(/\\/g, '\\\\')],
      [pair.from.replace(/\\/g, '/'), pair.to.replace(/\\/g, '/')],
    ];
    for (const [from, to] of variants) {
      if (!from) continue;
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      next = next.replace(new RegExp(escaped, 'gi'), () => to);
    }
  }
  return next;
}

/**
 * 把归档里暂存的 `__workspaces__/<id>/…` 搬到工作区的真实位置。
 *
 * 目标路径会先经过路径改写（换机器时旧 `C:\Users\old` 会变成新用户名）。
 * 搬完删掉暂存目录；跨盘 rename 失败时退回复制 + 删除。
 */
function restoreWorkspaces(
  targetDir: string,
  manifest: BackupManifest,
  rewriteEnabled: boolean,
  errors: string[],
): WorkspaceRestoreEntry[] | undefined {
  const roots = manifest.workspaceRoots ?? [];
  if (roots.length === 0) return undefined;
  const pairs = buildPathRewrites(manifest, targetDir, rewriteEnabled);
  const results: WorkspaceRestoreEntry[] = [];

  for (const root of roots) {
    const staged = path.join(targetDir, root.archivePrefix);
    if (!fs.existsSync(staged)) continue;
    const destination = path.resolve(rewritePathValue(root.path, pairs));
    let moved = 0;
    const walk = (absDir: string, relDir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch (error) {
        errors.push(`workspace ${root.name}: ${String(error)}`);
        return;
      }
      for (const entry of entries) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        const source = path.join(absDir, entry.name);
        const target = path.join(destination, rel);
        if (entry.isDirectory()) {
          fs.mkdirSync(target, { recursive: true });
          walk(source, rel);
          continue;
        }
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const previousMode = prepareWritable(target);
          try {
            fs.renameSync(source, target);
          } catch {
            fs.copyFileSync(source, target);
            fs.rmSync(source, { force: true });
          }
          if (previousMode !== null) {
            try {
              fs.chmodSync(target, previousMode);
            } catch {
              /* 还原属性失败不影响结果 */
            }
          }
          moved += 1;
        } catch (error) {
          errors.push(`workspace ${root.name}: ${rel} (${String(error)})`);
        }
      }
    };
    walk(staged, '');
    try {
      fs.rmSync(staged, { recursive: true, force: true });
    } catch {
      /* 暂存目录清不掉不影响恢复结果 */
    }
    results.push({ id: root.id, name: root.name, from: root.path, to: destination, files: moved });
  }

  // 暂存根目录清空后一并删掉，别在 $DSH_HOME 里留一个空壳
  try {
    const stageRoot = path.join(targetDir, WORKSPACE_ARCHIVE_PREFIX.replace(/\/$/, ''));
    if (fs.existsSync(stageRoot) && fs.readdirSync(stageRoot).length === 0) fs.rmdirSync(stageRoot);
  } catch {
    /* 清不掉就算了 */
  }

  return results.length > 0 ? results : undefined;
}

/** 对整包 payload 做路径改写；返回统计。 */
function rewritePayloads(
  payloads: Map<string, Buffer>,
  manifest: BackupManifest,
  targetDir: string,
  enabled: boolean,
): PathRewriteSummary | undefined {
  const pairs = buildPathRewrites(manifest, targetDir, enabled);
  if (pairs.length === 0) return undefined;
  let files = 0;
  let replacements = 0;
  for (const [name, content] of payloads) {
    if (name.includes('node_modules/') || name.startsWith('.backup-snapshot/')) continue;
    const result = rewriteBuffer(content, name, pairs);
    if (result.replacements > 0) {
      payloads.set(name, result.content);
      files += 1;
      replacements += result.replacements;
    }
  }
  return files > 0 ? { from: pairs[0].from, to: pairs[0].to, files, replacements } : undefined;
}

/** DSH 桌面进程是否在跑（只在 Windows 上探测）。 */
export function isDshRunning(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq deepseek-harness.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /deepseek-harness\.exe/i.test(output);
  } catch {
    return false;
  }
}

/**
 * 目标文件是只读时先临时放开写权限，返回原始 mode 供写完还原。
 *
 * DSH 把 `attachments/v1/objects/**` 存成只读对象（校验和寻址，防止被改写），
 * 直接覆盖会得到 EACCES/EPERM。恢复必须先放开、写完再还原成只读。
 */
function prepareWritable(destination: string): number | null {
  try {
    const stat = fs.statSync(destination);
    if (!stat.isFile()) return null;
    if ((stat.mode & 0o200) !== 0) return null;
    fs.chmodSync(destination, stat.mode | 0o200);
    return stat.mode;
  } catch {
    return null;
  }
}

/**
 * 恢复完成后的提醒。
 *
 * 一般备份不打包 `node_modules`（插件代码本身），而 profile 的 `package.json` /
 * `pnpm-lock.yaml` 是打包了的。恢复后如果某个 profile 有依赖清单却没有 node_modules，
 * 就必须重装插件，否则 DSH 会“看得到插件记录但加载不到插件”。
 */
function collectRestoreHints(targetDir: string, manifest: BackupManifest): string[] {
  const hints: string[] = [];
  const profilesDir = path.join(targetDir, 'profiles');
  let profiles: fs.Dirent[] = [];
  try {
    profiles = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return hints;
  }
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue;
    const profilePath = path.join(profilesDir, profile.name);
    const pkgPath = path.join(profilePath, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    if (fs.existsSync(path.join(profilePath, 'node_modules'))) continue;
    let dependencyCount = 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
      dependencyCount = Object.keys(parsed.dependencies ?? {}).length;
    } catch {
      dependencyCount = 0;
    }
    if (dependencyCount === 0) continue;
    const listed = (manifest.plugins ?? []).filter((plugin) => plugin.profile === profile.name);
    const listedText = listed.length > 0 ? `（备份时装有 ${listed.length} 个插件：${listed.slice(0, 6).map((p) => p.name).join(', ')}${listed.length > 6 ? ' …' : ''}）` : '';
    hints.push(
      `profile「${profile.name}」的插件代码没有随这次备份一起恢复${listedText}：一般备份不打包 node_modules。`
        + `请在 ${profilePath} 里执行 pnpm install --frozen-lockfile（lockfile 已在备份里），`
        + '或改用「完整备份」做一次自带插件文件的备份。',
    );
  }
  return hints;
}

/** 把会被覆盖的现有文件复制进快照目录。 */
function snapshotExisting(targetDir: string, relativePaths: string[]): string | undefined {
  const existing = relativePaths.filter((rel) => fs.existsSync(path.join(targetDir, rel)));
  if (existing.length === 0) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotDir = path.join(targetDir, '.backup-snapshot', stamp);
  for (const rel of existing) {
    const source = path.join(targetDir, rel);
    const destination = path.join(snapshotDir, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return snapshotDir;
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  try {
    return await restoreBackupInner(options);
  } catch (error) {
    // 密码错误（HMAC 校验或 GCM 认证失败）、文件损坏、路径不存在都走这里，给可读消息。
    return {
      ok: false,
      message: `恢复失败：${describeError(error)}`,
      fileCount: 0,
      errors: [String(error)],
      manifest: undefined as unknown as BackupManifest,
    };
  }
}

/** 把常见错误翻译成用户能看懂的说明。 */
function describeError(error: unknown): string {
  const text = String((error as any)?.message ?? error);
  if (/encrypted; a password is required/i.test(text)) {
    return '这个备份已加密，请先输入备份时设置的密码再恢复';
  }
  if (/unable to authenticate|bad decrypt|Unsupported state|HMAC mismatch|wrong password/i.test(text)) {
    return '密码不正确，或备份文件已损坏';
  }
  if (/manifest missing/i.test(text)) {
    return '这不是 dsh-backup-rescue 生成的备份（缺少 DSH-MANIFEST.json）';
  }
  if (/EACCES|EPERM/.test(text)) {
    return `没有写入权限：${text}（Windows 上只读文件会这样，通常是 attachments 对象；请确认有管理员权限）`;
  }
  if (/ENOENT/i.test(text)) return '备份文件不存在';
  return text;
}

async function restoreBackupInner(options: RestoreOptions): Promise<RestoreResult> {
  const targetDir = path.resolve(options.targetDir);
  const manifest = readManifest(options.backupPath, options.password);
  const errors: string[] = [];

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const zip = openArchive(options.backupPath, options.password);
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));

  // 1) 全量校验，任何不一致都不写盘。
  const payloads = new Map<string, Buffer>();
  for (const entry of zip.getEntries()) {
    if (entry.entryName === MANIFEST_NAME) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    if (name.includes('..')) {
      errors.push(`unsafe path in archive: ${name}`);
      continue;
    }
    const content = entry.getData();
    const record = expected.get(name);
    if (!record) {
      errors.push(`unexpected file in archive: ${name}`);
      continue;
    }
    const digest = sha256(content);
    if (digest !== record.sha256) {
      errors.push(`checksum mismatch: ${name}`);
      continue;
    }
    payloads.set(name, content);
  }
  for (const entry of manifest.files) {
    if (!payloads.has(entry.path)) errors.push(`missing file in archive: ${entry.path}`);
  }
  if (errors.length > 0) {
    return {
      ok: false,
      message: `备份校验失败（${errors.length} 处），未做任何修改`,
      fileCount: 0,
      errors,
      manifest,
    };
  }

  const planned = [...payloads.keys()].sort();

  // 2) dryRun 只报告。
  // 2.5) 换机器路径改写：把旧 home / 旧用户名根目录换成恢复目标的路径。
  const pathRewrites = rewritePayloads(payloads, manifest, targetDir, options.rewritePaths !== false);

  if (options.dryRun) {
    return {
      ok: true,
      message:
        `校验通过：${planned.length} 个文件可恢复`
        + (pathRewrites ? `；路径改写 ${pathRewrites.files} 个文件（${pathRewrites.from} → ${pathRewrites.to}）` : ''),
      fileCount: planned.length,
      planned,
      errors,
      pathRewrites,
      manifest,
    };
  }

  if (isDshRunning()) {
    return {
      ok: false,
      message: 'DSH 正在运行，请先完全退出 DSH 再恢复（或使用独立恢复器）',
      fileCount: 0,
      errors: ['dsh process is running'],
      manifest,
    };
  }

  // 3) 快照 + 写入。
  const snapshotPath =
    options.createSnapshot === false ? undefined : snapshotExisting(targetDir, planned);

  for (const [name, content] of payloads) {
    const destination = path.join(targetDir, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const previousMode = prepareWritable(destination);
    try {
      fs.writeFileSync(destination, content);
    } finally {
      if (previousMode !== null) {
        try {
          fs.chmodSync(destination, previousMode);
        } catch {
          /* 还原属性失败不影响恢复结果 */
        }
      }
    }
  }

  // 4) 复核。
  let verified = 0;
  for (const [name, content] of payloads) {
    try {
      const written = fs.readFileSync(path.join(targetDir, name));
      if (sha256(written) === sha256(content)) verified += 1;
      else errors.push(`verify failed: ${name}`);
    } catch (error) {
      errors.push(`verify failed: ${name} (${String(error)})`);
    }
  }

  // 4.5) 工作区文件：从暂存目录搬到（可能已改写的）真实位置。
  const workspaceRestores = restoreWorkspaces(targetDir, manifest, options.rewritePaths !== false, errors);

  const hints = collectRestoreHints(targetDir, manifest);

  return {
    ok: errors.length === 0,
    message:
      (errors.length === 0
        ? `恢复完成：${verified} 个文件已写入并校验通过`
        : `恢复完成但存在 ${errors.length} 处问题`)
      + (pathRewrites ? `；已把 ${pathRewrites.files} 个文件里的旧路径改写为 ${pathRewrites.to}（共 ${pathRewrites.replacements} 处）` : '')
      + (workspaceRestores
        ? `；工作区文件已恢复到 ${workspaceRestores.map((item) => `${item.name}（${item.files} 个文件 → ${item.to}）`).join('、')}`
        : ''),
    fileCount: verified,
    snapshotPath,
    planned,
    errors,
    hints,
    pathRewrites,
    workspaceRestores,
    manifest,
  };
}
