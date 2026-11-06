/**
 * 备份文件迁移：把备份根目录里的内容整体搬到新位置。
 *
 * 目录布局是 `<root>/<normal|full>/<备份名>/…`（0.3.3 起）或平铺的
 * `<root>/<备份名>.zip`（0.3.2 及更早）。迁移时按“顶层条目”搬：
 *  - normal/、full/ 这类分类目录：逐个把里面的备份文件夹搬到新位置的同名目录下（合并，不覆盖）
 *  - 其它目录 / 归档文件：直接搬到新根目录
 *
 * 同盘用 rename（快、保留 mtime），跨盘 rename 会抛 EXDEV，这时退回复制 + 删除。
 * 任何单项失败都只记录、不中断，最后统一返回结果，避免“搬了一半还不知道”。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MigrationFailure {
  from: string;
  error: string;
}

export interface MigrationResult {
  ok: boolean;
  from: string;
  to: string;
  /** 源与目标解析后相同，什么也没做。 */
  skipped: boolean;
  /** 成功搬走的顶层条目（相对源根目录的路径）。 */
  moved: string[];
  /** 迁移的文件总数（含备份文件夹里的每个文件）。 */
  fileCount: number;
  failures: MigrationFailure[];
  message: string;
}

/** 目标已存在同名条目时，用这个后缀避开覆盖。 */
function uniqueTarget(target: string): string {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const base = path.basename(target);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${base}-merged-${stamp}`);
}

function countFiles(target: string): number {
  let count = 0;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) count += 1;
    }
  };
  walk(target);
  return count;
}

function copyRecursive(source: string, target: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) copyRecursive(path.join(source, entry), path.join(target, entry));
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  try {
    // 保留时间戳：备份列表按 mtime 排序，丢了时间顺序会乱
    fs.utimesSync(target, stat.atime, stat.mtime);
  } catch {
    /* 时间戳只是排序用，失败无妨 */
  }
}

function removeRecursive(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

/** 同盘 rename，跨盘（EXDEV）退回复制 + 删除。 */
function movePath(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(source, target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
  }
  copyRecursive(source, target);
  removeRecursive(source);
}

/**
 * 迁移一份源条目：
 *  - 源是目录且目标已是目录 → 逐子项合并（保留双方内容）
 *  - 其余情况 → 目标已存在就加后缀，避免覆盖已有备份
 */
function moveMerge(source: string, target: string): number {
  const sourceStat = fs.lstatSync(source);
  let destination = target;
  if (fs.existsSync(destination)) {
    const destinationStat = fs.lstatSync(destination);
    if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
      let moved = 0;
      for (const child of fs.readdirSync(source)) {
        moved += moveMerge(path.join(source, child), path.join(destination, child));
      }
      try {
        fs.rmdirSync(source);
      } catch {
        /* 非空就留着 */
      }
      return moved;
    }
    destination = uniqueTarget(destination);
  }
  const files = countFiles(source);
  movePath(source, destination);
  return files;
}

/** 删掉源目录里已经搬空的子目录（保留源根目录本身）。 */
function cleanupEmptyDirs(root: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    try {
      const children = fs.readdirSync(full);
      if (children.length === 0) fs.rmdirSync(full);
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 把 `fromDir` 里的全部备份搬到 `toDir`。
 *
 * 不做任何“看起来像备份”的过滤：用户手工放进备份目录的东西也一起搬走，
 * 这样切换位置后旧目录能真正空掉。
 */
export function migrateBackups(fromDir: string, toDir: string): MigrationResult {
  const from = path.resolve(fromDir);
  const to = path.resolve(toDir);
  const result: MigrationResult = {
    ok: true,
    from,
    to,
    skipped: false,
    moved: [],
    fileCount: 0,
    failures: [],
    message: '',
  };

  if (from === to) {
    result.skipped = true;
    result.message = '新旧位置相同，无需迁移。';
    return result;
  }
  if (!fs.existsSync(from)) {
    result.message = `旧位置不存在（${from}），无需迁移。`;
    return result;
  }
  try {
    fs.mkdirSync(to, { recursive: true });
  } catch (error) {
    result.ok = false;
    result.failures.push({ from: to, error: error instanceof Error ? error.message : String(error) });
    result.message = `无法创建新位置：${result.failures[0].error}`;
    return result;
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch (error) {
    result.ok = false;
    result.failures.push({ from, error: error instanceof Error ? error.message : String(error) });
    result.message = `无法读取旧位置：${result.failures[0].error}`;
    return result;
  }

  for (const entry of entries) {
    // 目标就在源里面（或反过来）时跳过，避免无限自我复制
    const source = path.join(from, entry.name);
    if (to === source || to.startsWith(`${source}${path.sep}`) || source.startsWith(`${to}${path.sep}`)) {
      result.failures.push({ from: source, error: '新位置与旧位置存在包含关系，已跳过' });
      continue;
    }
    try {
      const files = moveMerge(source, path.join(to, entry.name));
      result.fileCount += files;
      result.moved.push(entry.name);
    } catch (error) {
      result.failures.push({ from: source, error: error instanceof Error ? error.message : String(error) });
    }
  }

  cleanupEmptyDirs(from);
  if (result.failures.length > 0) result.ok = false;
  result.message = result.ok
    ? `已迁移 ${result.moved.length} 项、${result.fileCount} 个文件到 ${to}`
    : `迁移未全部成功：${result.moved.length} 项成功，${result.failures.length} 项失败`;
  return result;
}
