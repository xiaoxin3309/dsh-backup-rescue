/**
 * 插件设置（持久化到 `<dshHome>/dsh-backup-rescue/settings.json`）。
 *
 * 两份设置：
 *  - `backupDir`：备份存放根目录；null 表示用默认位置 `<dshHome>/dsh-backup-rescue/exports`
 *  - `autoBackup`：自动备份（定间隔、只保留最近 N 份普通备份）
 *
 * 这里只做“读、写、校验、合并”，不碰调度与文件迁移（见 scheduler.ts / migrate.ts），
 * 目的是让设置能单独跑单测、也方便被 route 与 tool 两侧共用。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 自动备份设置。 */
export interface AutoBackupSettings {
  /** 是否启用。 */
  enabled: boolean;
  /** 间隔（分钟），最小 1。 */
  intervalMinutes: number;
  /** 最多保留多少份普通备份（超出删除最早的），最小 1。 */
  maxBackups: number;
}

/** 插件全部设置（落盘形状）。 */
export interface PluginSettings {
  /** 备份根目录；null = 默认位置。 */
  backupDir: string | null;
  autoBackup: AutoBackupSettings;
}

/** 设置补丁：只写想改的字段。 */
export interface SettingsPatch {
  backupDir?: string | null;
  autoBackup?: Partial<AutoBackupSettings>;
}

export const DEFAULT_AUTO_BACKUP: AutoBackupSettings = {
  enabled: false,
  intervalMinutes: 60,
  maxBackups: 10,
};

export const DEFAULT_SETTINGS: PluginSettings = {
  backupDir: null,
  autoBackup: { ...DEFAULT_AUTO_BACKUP },
};

/** 间隔下限/上限（分钟）：1 分钟 ~ 30 天。 */
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 60 * 24 * 30;
/** 保留份数上限，避免误填一个大数把磁盘写满。 */
const MAX_KEEP_BACKUPS = 5000;

/** `<dshHome>/dsh-backup-rescue/settings.json`。 */
export function settingsFilePath(dshHome: string): string {
  return path.join(dshHome, 'dsh-backup-rescue', 'settings.json');
}

/** 默认备份根目录 `<dshHome>/dsh-backup-rescue/exports`。 */
export function defaultBackupDir(dshHome: string): string {
  return path.join(dshHome, 'dsh-backup-rescue', 'exports');
}

/** 展开 `~`、`%USERPROFILE%`、`$HOME` 这类写法，并归一化分隔符。 */
export function expandUserPath(value: string): string {
  let text = value.trim().replace(/^"(.*)"$/, '$1');
  if (!text) return '';
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    text = path.join(os.homedir(), text.slice(1).replace(/^[/\\]/, ''));
  }
  text = text.replace(/^%USERPROFILE%/i, os.homedir()).replace(/^\$HOME/, os.homedir());
  return path.normalize(text);
}

/** 把任意输入夹到合法区间（非数字回退默认值）。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** 校验并补全一份设置（用于读盘后修复脏数据，也用于写盘前规范化）。 */
export function normalizeSettings(input: unknown): PluginSettings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, any>;
  const autoRaw = (typeof raw.autoBackup === 'object' && raw.autoBackup !== null ? raw.autoBackup : {}) as Record<string, any>;

  let backupDir: string | null = null;
  if (typeof raw.backupDir === 'string' && raw.backupDir.trim()) {
    const expanded = expandUserPath(raw.backupDir);
    // 只接受绝对路径：相对路径会被解释成“相对 DSH 进程的当前目录”，结果不可预期
    if (expanded && path.isAbsolute(expanded)) backupDir = expanded;
  }

  return {
    backupDir,
    autoBackup: {
      enabled: autoRaw.enabled === true,
      intervalMinutes: clampInt(autoRaw.intervalMinutes, DEFAULT_AUTO_BACKUP.intervalMinutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES),
      maxBackups: clampInt(autoRaw.maxBackups, DEFAULT_AUTO_BACKUP.maxBackups, 1, MAX_KEEP_BACKUPS),
    },
  };
}

/** 读设置；文件不存在/损坏时回退默认值（永远不抛）。 */
export function loadSettings(dshHome: string): PluginSettings {
  try {
    const raw = fs.readFileSync(settingsFilePath(dshHome), 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

/** 写设置（原子替换：先写临时文件再 rename），返回落盘后的规范值。 */
export function saveSettings(dshHome: string, settings: PluginSettings): PluginSettings {
  const normalized = normalizeSettings(settings);
  const file = settingsFilePath(dshHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return normalized;
}

/** 把补丁合并进现有设置（字段级，autoBackup 只覆盖出现的键）。 */
export function mergePatch(current: PluginSettings, patch: SettingsPatch): PluginSettings {
  const next: PluginSettings = {
    backupDir: patch.backupDir === undefined ? current.backupDir : patch.backupDir,
    autoBackup: {
      ...current.autoBackup,
      ...(patch.autoBackup ?? {}),
    },
  };
  return normalizeSettings(next);
}

/** 实际使用的备份根目录：设置值优先，否则默认位置。 */
export function effectiveBackupDir(settings: PluginSettings, dshHome: string): string {
  return settings.backupDir && settings.backupDir.trim() ? settings.backupDir : defaultBackupDir(dshHome);
}

/** 设置是否与默认值完全一致（用于 UI 上标注“默认”）。 */
export function isDefaultSettings(settings: PluginSettings, dshHome: string): boolean {
  return (
    (settings.backupDir ?? null) === null &&
    settings.autoBackup.enabled === DEFAULT_AUTO_BACKUP.enabled &&
    settings.autoBackup.intervalMinutes === DEFAULT_AUTO_BACKUP.intervalMinutes &&
    settings.autoBackup.maxBackups === DEFAULT_AUTO_BACKUP.maxBackups &&
    effectiveBackupDir(settings, dshHome) === defaultBackupDir(dshHome)
  );
}
