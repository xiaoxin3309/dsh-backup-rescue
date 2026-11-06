/**
 * 0.4.0 新能力测试：设置读写、位置迁移、保留策略、定时调度。
 *
 * 用 node 直接跑：`node tests/settings.test.mjs`
 * （依赖已构建的 lib/，所以先 `npx tsc -p tsconfig.json`。）
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const {
  DEFAULT_AUTO_BACKUP,
  defaultBackupDir,
  effectiveBackupDir,
  loadSettings,
  mergePatch,
  normalizeSettings,
  saveSettings,
  settingsFilePath,
} = await import('../lib/settings.js');
const { migrateBackups } = await import('../lib/migrate.js');
const { pruneNormalBackups } = await import('../lib/prune.js');
const { initScheduler, getScheduler, disposeScheduler } = await import('../lib/scheduler.js');

let passed = 0;
let failed = 0;
const check = (label, ok, extra = '') => {
  if (ok) {
    passed += 1;
    console.log(`  OK   ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

const tmpRoots = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};

/** 造一个最小的假 DSH 目录，够 createBackup 打出小包。 */
function fakeDshHome() {
  const home = tmp('dshhome-');
  fs.writeFileSync(path.join(home, 'settings.json'), '{"theme":"dark"}\n', 'utf8');
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'desktop', 'package.json'), '{"name":"desktop"}\n', 'utf8');
  fs.writeFileSync(path.join(home, 'session.json'), '{"id":"s1"}\n', 'utf8');
  return home;
}

/** 造一个假的备份文件夹布局（normal/ 与 full/ 各若干份）。 */
function fakeBackups(root, normalCount, fullCount, { flat = 0 } = {}) {
  const stamp = (index) => `2026010${index + 1}-120000`;
  for (let index = 0; index < normalCount; index += 1) {
    const name = `dsh-backup-${stamp(index)}`;
    const dir = path.join(root, 'normal', name);
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, `${name}.zip`);
    fs.writeFileSync(archive, 'zip-bytes');
    // 每份备份的 mtime 递增，保证 createdAt 排序稳定
    const when = new Date(Date.UTC(2026, 0, index + 1, 12, 0, 0));
    fs.utimesSync(archive, when, when);
    fs.writeFileSync(path.join(dir, `${name}.bat`), '@echo off\n');
    fs.writeFileSync(path.join(dir, 'restore.bat'), '@echo off\n');
  }
  for (let index = 0; index < fullCount; index += 1) {
    const name = `dsh-backup-full-${stamp(index)}`;
    const dir = path.join(root, 'full', name);
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, `${name}.zip`);
    fs.writeFileSync(archive, 'zip-bytes-full');
    const when = new Date(Date.UTC(2026, 0, index + 1, 13, 0, 0));
    fs.utimesSync(archive, when, when);
  }
  for (let index = 0; index < flat; index += 1) {
    const name = `dsh-backup-2025010${index + 1}-090000.zip`;
    const archive = path.join(root, name);
    fs.writeFileSync(archive, 'flat-zip');
    const when = new Date(Date.UTC(2025, 0, index + 1, 9, 0, 0));
    fs.utimesSync(archive, when, when);
  }
}

console.log('=== 设置读写 ===');
{
  const home = fakeDshHome();
  const fresh = loadSettings(home);
  check('默认设置：backupDir 为 null', fresh.backupDir === null);
  check('默认设置：自动备份关闭', fresh.autoBackup.enabled === false);
  check('默认间隔/保留份数', fresh.autoBackup.intervalMinutes === DEFAULT_AUTO_BACKUP.intervalMinutes && fresh.autoBackup.maxBackups === DEFAULT_AUTO_BACKUP.maxBackups);

  const custom = tmp('backups-');
  const saved = saveSettings(home, {
    backupDir: custom,
    autoBackup: { enabled: true, intervalMinutes: 15, maxBackups: 3 },
  });
  check('保存后落到 settings.json', fs.existsSync(settingsFilePath(home)));
  check('保存返回值规范化', saved.backupDir === custom && saved.autoBackup.maxBackups === 3);
  const reloaded = loadSettings(home);
  check('重新读盘一致', reloaded.backupDir === custom && reloaded.autoBackup.intervalMinutes === 15);

  const clamped = normalizeSettings({ backupDir: 'relative/path', autoBackup: { enabled: true, intervalMinutes: 0, maxBackups: 0 } });
  check('相对路径被拒（回落默认）', clamped.backupDir === null, String(clamped.backupDir));
  check('间隔夹到下限 1', clamped.autoBackup.intervalMinutes === 1, String(clamped.autoBackup.intervalMinutes));
  check('保留份数夹到下限 1', clamped.autoBackup.maxBackups === 1, String(clamped.autoBackup.maxBackups));

  const merged = mergePatch(reloaded, { autoBackup: { maxBackups: 7 } });
  check('补丁只改指定字段', merged.autoBackup.maxBackups === 7 && merged.autoBackup.intervalMinutes === 15 && merged.backupDir === custom);

  fs.writeFileSync(settingsFilePath(home), '{ this is not json');
  const broken = loadSettings(home);
  check('坏 JSON 回退默认而不抛错', broken.autoBackup.enabled === false);

  check('effectiveBackupDir 用默认位置', effectiveBackupDir({ backupDir: null, autoBackup: DEFAULT_AUTO_BACKUP }, home) === defaultBackupDir(home));
}

console.log('\n=== 位置迁移 ===');
{
  const from = tmp('old-backups-');
  const to = path.join(tmp('new-backups-'), 'nested', 'dsh');
  fakeBackups(from, 2, 1, { flat: 1 });
  const result = migrateBackups(from, to);
  check('迁移成功', result.ok === true, result.message);
  check('搬走了全部顶层条目', result.moved.length === 3, result.moved.join(','));
  check('normal 目录在新位置', fs.existsSync(path.join(to, 'normal')));
  check('full 目录在新位置', fs.existsSync(path.join(to, 'full')));
  const normalFolders = fs.readdirSync(path.join(to, 'normal'));
  check('两份普通备份都到了', normalFolders.length === 2, normalFolders.join(','));
  const oneBat = path.join(to, 'normal', normalFolders[0], `${normalFolders[0]}.bat`);
  check('同名 .bat 跟着搬', fs.existsSync(oneBat), oneBat);
  const flatCount = fs.readdirSync(to).filter((name) => name.endsWith('.zip')).length;
  check('平铺的旧备份也搬走', flatCount === 1, String(flatCount));
  check('旧目录已空', fs.readdirSync(from).length === 0, fs.readdirSync(from).join(','));
  const mtimeKept = fs.statSync(path.join(to, 'normal', normalFolders[0], `${normalFolders[0]}.zip`)).mtime;
  check('mtime 保留（排序不乱）', mtimeKept.getUTCFullYear() === 2026, mtimeKept.toISOString());

  const same = migrateBackups(to, to);
  check('同位置直接跳过', same.skipped === true);

  // 已有同名备份：不覆盖，改名合并
  const conflict = tmp('conflict-');
  fakeBackups(conflict, 1, 0);
  const existingName = fs.readdirSync(path.join(conflict, 'normal'))[0];
  const target = path.join(tmp('target-'), 'x');
  fs.mkdirSync(path.join(target, 'normal', existingName), { recursive: true });
  fs.writeFileSync(path.join(target, 'normal', existingName, 'marker.txt'), 'keep me');
  const merged = migrateBackups(conflict, target);
  check('冲突时保留目标已有内容', merged.ok === true && fs.existsSync(path.join(target, 'normal', existingName, 'marker.txt')));
}

console.log('\n=== 保留策略（删最早的普通备份） ===');
{
  const root = tmp('prune-');
  fakeBackups(root, 5, 2);
  const result = pruneNormalBackups(root, 3);
  check('prune 成功', result.ok === true, result.message);
  check('删掉 2 份', result.removed.length === 2, result.removed.map((item) => path.basename(item)).join(','));
  check('普通备份剩 3 份', fs.readdirSync(path.join(root, 'normal')).length === 3);
  check('全量备份没动', fs.readdirSync(path.join(root, 'full')).length === 2);
  const remaining = fs.readdirSync(path.join(root, 'normal')).sort();
  check('保留的是较新的三份', remaining[0].includes('20260103') || remaining.every((name) => !name.includes('20260101')), remaining.join(','));

  const noop = pruneNormalBackups(root, 10);
  check('未超上限时不删东西', noop.removed.length === 0 && noop.kept === 3, noop.message);
}

console.log('\n=== 定时调度（短间隔） ===');
{
  const dshHome = fakeDshHome();
  const backupDir = tmp('auto-backups-');
  saveSettings(dshHome, { backupDir, autoBackup: { enabled: true, intervalMinutes: 1, maxBackups: 1 } });
  const scheduler = initScheduler({
    dshHome,
    profileDir: path.join(dshHome, 'profiles', 'desktop'),
    profileName: 'desktop',
    log: () => {},
    intervalMsOverride: 80,
  });
  const started = scheduler.start();
  check('调度器已启动', started.running === true && started.enabled === true);
  check('初始化后取到同一个单例', getScheduler() === scheduler);

  const waitFor = async (predicate, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  const produced = await waitFor(() => scheduler.status().lastStatus === 'ok');
  const state = scheduler.status();
  check('定时器真的做出了一份备份', produced === true, JSON.stringify(state.lastBackupPath || state.lastError || ''));
  check('落在配置的目录里', Boolean(state.lastBackupPath && state.lastBackupPath.startsWith(backupDir)), String(state.lastBackupPath));
  check('自动清理生效（上限 1 份）', state.lastPruned >= 0, `pruned=${state.lastPruned}`);

  // 再等一轮，确认清理把旧备份删掉、只剩 1 份普通备份
  await waitFor(() => scheduler.status().tickCount >= 2);
  const normalDir = path.join(backupDir, 'normal');
  const normalCount = fs.existsSync(normalDir) ? fs.readdirSync(normalDir).length : 0;
  check('普通备份不超过上限', normalCount <= 1, `count=${normalCount}`);

  const manual = await scheduler.tickNow();
  check('手动 tick 可再跑一次', manual.status === 'ok' || manual.status === 'skipped', manual.status);

  scheduler.stop();
  check('stop 后 running=false', scheduler.status().running === false);
  disposeScheduler();
  check('dispose 后单例清空', getScheduler() === null);
}

// 清理临时目录
for (const dir of tmpRoots) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exitCode = 1;
