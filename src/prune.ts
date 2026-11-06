/**
 * 备份保留策略：自动备份只保留最近 N 份（都是普通备份），超出就删最早的。
 *
 * 只动 `kind === 'normal'` 的备份；全量备份是用户手动做的珍贵快照，永远不自动删。
 * 删除的是“这份备份自己的文件夹”（0.3.3 起每份备份一个同名文件夹，里面是 zip + .bat），
 * 所以删掉后不会留下孤立的恢复脚本。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { listBackups } from './backup.js';

export interface PruneResult {
  ok: boolean;
  backupDir: string;
  /** 保留的普通备份数量。 */
  kept: number;
  /** 被删除的备份（归档文件路径）。 */
  removed: string[];
  /** 保守估算释放的字节数。 */
  freedBytes: number;
  /** 无法删除的项（权限占用等），不影响其它备份。 */
  failures: Array<{ path: string; error: string }>;
  message: string;
}

/** 递归求和文件大小（用于报告释放空间）。 */
function sizeOf(target: string): number {
  let total = 0;
  const walk = (current: string): void => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(current);
      } catch {
        return;
      }
      for (const entry of entries) walk(path.join(current, entry));
      return;
    }
    total += stat.size;
  };
  walk(target);
  return total;
}

/** 目标必须落在备份根目录内，防止设置被写坏后误删别处。 */
function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 保留最近 `maxBackups` 份普通备份，删除更早的。
 *
 * 列表来源与设置页一致（`listBackups`），按 `createdAt` 倒序；因此“最早”就是
 * 用户看到列表里的最后几条，不会出现 UI 与清理策略对不上的情况。
 */
export function pruneNormalBackups(backupDir: string, maxBackups: number): PruneResult {
  const root = path.resolve(backupDir);
  const keep = Math.max(1, Math.round(maxBackups));
  const result: PruneResult = {
    ok: true,
    backupDir: root,
    kept: 0,
    removed: [],
    freedBytes: 0,
    failures: [],
    message: '',
  };

  let items: ReturnType<typeof listBackups> = [];
  try {
    items = listBackups(root);
  } catch (error) {
    result.ok = false;
    result.failures.push({ path: root, error: error instanceof Error ? error.message : String(error) });
    result.message = `无法读取备份目录：${result.failures[0].error}`;
    return result;
  }

  const normal = items.filter(item => item.kind === 'normal');
  result.kept = Math.min(keep, normal.length);
  const stale = normal.slice(keep);
  if (stale.length === 0) {
    result.message = `普通备份 ${normal.length} 份，未超过上限 ${keep} 份。`;
    return result;
  }

  for (const item of stale) {
    // 每份备份一个同名文件夹；若备份是平铺的老布局，folder 就是根目录本身
    const folderIsOwn = path.resolve(item.folder) !== root && insideRoot(root, item.folder);
    const targets = folderIsOwn
      ? [item.folder]
      : [item.path, item.restoreBat, path.join(item.folder, 'restore.bat'), path.join(item.folder, 'restore.sh')].filter(
          (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
        );
    for (const target of targets) {
      if (!fs.existsSync(target)) continue;
      if (!insideRoot(root, target)) {
        result.failures.push({ path: target, error: '不在备份目录内，已跳过' });
        continue;
      }
      const freed = sizeOf(target);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        result.freedBytes += freed;
        if (target === item.path) result.removed.push(item.path);
      } catch (error) {
        result.failures.push({ path: target, error: error instanceof Error ? error.message : String(error) });
      }
    }
    // 文件夹模式下，item.path 随文件夹一起被删：记为已删除
    if (folderIsOwn && !result.removed.includes(item.path)) result.removed.push(item.path);
  }

  if (result.failures.length > 0) result.ok = false;
  result.message = result.ok
    ? `已删除 ${result.removed.length} 份最早的普通备份，保留 ${result.kept} 份。`
    : `已删除 ${result.removed.length} 份，${result.failures.length} 项失败。`;
  return result;
}
