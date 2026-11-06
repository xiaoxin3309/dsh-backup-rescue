/**
 * DSH Backup Plugin - 共享类型定义
 *
 * 所有模块共用的接口和枚举都集中在这里，避免循环依赖和重复声明。
 */

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

/**
 * 加密封装文件头魔数（ASCII "DSHBK002" = 8 字节）。
 *
 * 0.4.1 起：PBKDF2-HMAC-SHA256(200000) + AES-256-CBC + HMAC-SHA256，
 * 因为独立恢复脚本只能用 Windows 自带的 PowerShell 5.1（无 AesGcm、无 scrypt）。
 * 旧格式 "DSHBK001"（scrypt + AES-256-GCM）仍可解密。
 */
export const ENC_MAGIC = 'DSHBK002';

/** 旧加密封装魔数（0.3.x–0.4.0），只读不写。 */
export const ENC_MAGIC_V1 = 'DSHBK001';

/** PBKDF2 迭代次数（当前格式）。 */
export const ENC_PBKDF2_ITERATIONS = 200000;

/** 备份 ZIP 内的清单文件名。 */
export const MANIFEST_NAME = 'DSH-MANIFEST.json';

/** 备份格式版本号（当前为 1）。 */
export const BACKUP_FORMAT_VERSION = 1;

/** 备份插件版本，由 package.json 同步。 */
export const PLUGIN_VERSION = '0.4.5';

/** 备份类型：一般备份 / 全量备份（各自落在一个固定子目录里）。 */
export type BackupKind = 'normal' | 'full';

/** 备份类型 → 备份根目录下的子目录名。 */
export const BACKUP_KIND_DIR: Record<BackupKind, string> = {
  normal: 'normal',
  full: 'full',
};

export interface BackupOptions {
  /** $DSH_HOME 绝对路径。 */
  dshHome: string;
  /** 当前 profile 目录；仅用于写入清单，默认从 dshHome 推导。 */
  profileDir?: string;
  /** 当前 profile 名，默认 'desktop'。 */
  profileName?: string;
  /** 输出目录，默认 `<dshHome>/dsh-backup-rescue/exports`。 */
  backupDir?: string;
  /** 是否把 credentials 明文一起打包（默认只打包文件本身，值本就落在磁盘上）。 */
  includeSecrets?: boolean;
  /** 是否包含 sessions（默认包含）。 */
  includeSessions?: boolean;
  /** 是否包含 attachments（默认包含；置 false 可显著减小体积）。 */
  includeAttachments?: boolean;
  /** 加密密码；提供则输出 .zip.enc。 */
  password?: string;
  /** 额外排除的相对路径前缀。 */
  excludePatterns?: string[];
  /**
   * 一般备份是否也把 `node_modules`（插件代码本身）打进去。
   * 默认 false：体积小、靠 lockfile 重装；true 时约 +几百 MB，但换机器/离线也能直接跑。
   */
  includeNodeModules?: boolean;
  /**
   * 是否把工作区文件也打包。工作区目录不在 $DSH_HOME 里（例如
   * `C:\Users\<user>\Documents\deepseek-harness\default-workspace`），
   * 只有打开这个开关才会从 `storages/workspace.json` 读出登记路径并逐文件收集。
   */
  includeWorkspaces?: boolean;
}

/** 备份里一段工作区的登记信息。 */
export interface WorkspaceRootEntry {
  /** 工作区 id（storages/workspace.json 里的 key）。 */
  id: string;
  /** 工作区标题。 */
  name: string;
  /** 备份时的原始绝对路径。 */
  path: string;
  /** 归档内的前缀，例如 `__workspaces__/<id>/`。 */
  archivePrefix: string;
  fileCount: number;
  totalBytes: number;
}

export interface BackupEntry {
  /** 相对 $DSH_HOME 的 posix 路径。 */
  path: string;
  sha256: string;
  size: number;
}

/** 扫描阶段只记路径与大小；哈希在真正读入内存时计算。 */
export interface CollectedFile {
  /** 相对 $DSH_HOME 的 posix 路径。 */
  path: string;
  size: number;
}

/** 插件清单条目：一般备份不打包 node_modules，但会把装了什么记下来。 */
export interface PluginInventoryEntry {
  /** profile 名，例如 desktop。 */
  profile: string;
  /** npm 包名，例如 dsh-backup-rescue。 */
  name: string;
  version: string;
}

export interface BackupManifest {
  formatVersion: number;
  pluginVersion: string;
  createdAt: string;
  dshHome: string;
  profileName: string;
  profileDir: string;
  includeSecrets: boolean;
  includedSessions: boolean;
  includedAttachments: boolean;
  encrypted: boolean;
  /** 本次备份是否把 node_modules（插件代码本身）打进了包。 */
  includedNodeModules?: boolean;
  /** 备份时各 profile 已安装的插件（name@version）；一般备份靠它决定恢复后要装什么。 */
  plugins?: PluginInventoryEntry[];
  /** 本次是否把工作区文件也打了进去。 */
  includedWorkspaces?: boolean;
  /** 本次打包的各个工作区（恢复时按它把文件放回原位置）。 */
  workspaceRoots?: WorkspaceRootEntry[];
  fileCount: number;
  totalBytes: number;
  files: BackupEntry[];
  skipped: string[];
  runtime: { node: string; platform: string };
}

export interface BackupResult {
  ok: boolean;
  /** 最终落盘文件（.zip 或 .zip.enc）。 */
  path: string;
  /** 与 path 相同，保留旧字段名以兼容调用方。 */
  archive: string;
  /** 本份备份独占的文件夹（与压缩包同名），zip 与 .bat 都在里面。 */
  folder: string;
  /** 双击即恢复本份备份的 .bat（写失败时为 undefined）。 */
  restoreBat?: string;
  encrypted: boolean;
  fileCount: number;
  totalBytes: number;
  manifest: BackupManifest;
}

export interface BackupListItem {
  path: string;
  name: string;
  size: number;
  encrypted: boolean;
  createdAt: string;
  /** 一般备份 / 全量备份。 */
  kind: BackupKind;
  /** 本份备份所在文件夹（zip 与同名 .bat 都在这里）。 */
  folder: string;
  /** 与该备份对应的恢复脚本（同文件夹同名 .bat）；缺失则为 null。 */
  restoreBat: string | null;
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  /** 备份文件路径（.zip / .zip.enc）。 */
  backupPath: string;
  /** 恢复目标根目录，通常是 $DSH_HOME。 */
  targetDir: string;
  /** 加密备份的密码。 */
  password?: string;
  /** 只校验与列出计划，不写盘。 */
  dryRun?: boolean;
  /** 覆盖前是否生成 .backup-snapshot（默认 true）。 */
  createSnapshot?: boolean;
  /**
   * 是否把备份里记录的旧 `$DSH_HOME` / 用户名路径改写成恢复目标的路径（默认 true）。
   * 换机器（用户名不同）时，`storages/workspace.json` 之类写死的绝对路径靠它接上。
   */
  rewritePaths?: boolean;
}

/** 一次恢复里路径改写的统计。 */
export interface PathRewriteSummary {
  from: string;
  to: string;
  /** 内容被改写的文件数。 */
  files: number;
  /** 替换次数。 */
  replacements: number;
}

/** 一次恢复里某个工作区的落盘结果。 */
export interface WorkspaceRestoreEntry {
  id: string;
  name: string;
  /** 备份时的原始路径。 */
  from: string;
  /** 实际写入的路径（可能经过路径改写）。 */
  to: string;
  files: number;
}

export interface RestoreResult {
  ok: boolean;
  message: string;
  /** 实际写入（或将要写入）的文件数。 */
  fileCount: number;
  /** 覆盖前快照目录。 */
  snapshotPath?: string;
  /** dryRun 时的文件清单。 */
  planned?: string[];
  /** 校验失败或写入失败的文件。 */
  errors: string[];
  /** 恢复后需要用户注意的事（例如“插件文件不在备份里，需要重装”）。 */
  hints?: string[];
  /** 路径改写结果（没改写时为 undefined）。 */
  pathRewrites?: PathRewriteSummary;
  /** 工作区文件的恢复结果（备份里没有工作区时为 undefined）。 */
  workspaceRestores?: WorkspaceRestoreEntry[];
  manifest: BackupManifest;
}

// ---------------------------------------------------------------------------
// 工具 / 路由
// ---------------------------------------------------------------------------

export type Logger = (message: string) => void;

export interface DefaultsResult {
  dshHome: string;
  profileDir: string;
  profileName: string;
}

// ---------------------------------------------------------------------------
// 完整备份
// ---------------------------------------------------------------------------

export interface FullBackupOptions extends BackupOptions {
  /** 是否包含所有通常被跳过的目录（node_modules、dsh-runtimes、cache、logs、web-login、speech-to-text 等）。默认 false。 */
  includeEverything?: boolean;
}

export interface FullBackupResult {
  ok: boolean;
  path: string;
  archive: string;
  /** 本份备份独占的文件夹（与压缩包同名）。 */
  folder: string;
  /** 双击即恢复本份备份的 .bat（写失败时为 undefined）。 */
  restoreBat?: string;
  encrypted: boolean;
  fileCount: number;
  totalBytes: number;
  manifest: BackupManifest;
  includedExtraDirs: string[];
  note: string;
}

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  ok: boolean;
  currentVersion: string;
  latestVersion: string;
  isUpToDate: boolean;
  publishTime?: string;
  changelogUrl?: string;
  error?: string;
}

export interface UpdateResult {
  ok: boolean;
  message: string;
  /** 是否真的换了版本（已是最新时为 false）。 */
  updated?: boolean;
  oldVersion?: string;
  newVersion?: string;
  latestVersion?: string;
  /** 更新前自动创建的一般备份（没备份时为空）。 */
  backupPath?: string;
  backupFolder?: string;
  /** 更新过程的逐条日志（pnpm/npm 输出摘要）。 */
  log?: string[];
  error?: string;
}
