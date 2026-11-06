/**
 * DSH Backup Plugin - Test Suite
 *
 * 测试备份和恢复功能（匹配 0.3.0 API 签名）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// 动态导入（ESM）
const { createBackup, listBackups, readManifest, encryptArchive, decryptArchive, openArchive } =
  await import('../lib/backup.js');
const { createFullBackup } = await import('../lib/backup.js');
const { restoreBackup } = await import('../lib/restore.js');

/** 创建测试目录 */
function createTestDirectory(): string {
  const testDir = path.join(__dirname, 'test-backup-data');
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  // 创建测试文件
  fs.writeFileSync(path.join(testDir, 'test1.txt'), 'Test file 1');
  fs.writeFileSync(path.join(testDir, 'test2.txt'), 'Test file 2');

  const subDir = path.join(testDir, 'subdir');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'test3.txt'), 'Test file 3');

  // 也创建一个要被跳过的目录（node_modules 应被跳过）
  fs.mkdirSync(path.join(testDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(testDir, 'node_modules', 'fake.js'), 'should be skipped');

  return testDir;
}

/** 清理测试目录 */
function cleanupTestDirectory(testDir: string) {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
}

/** 运行测试 */
async function runTests() {
  let passed = 0;
  let failed = 0;

  const log = (label: string, ok: boolean, msg: string) => {
    if (ok) {
      console.log(`  ✓ ${label}: ${msg}`);
      passed += 1;
    } else {
      console.log(`  ✗ ${label}: ${msg}`);
      failed += 1;
    }
  };

  console.log('=== DSH Backup Plugin Test Suite ===\n');

  const testDir = createTestDirectory();
  const backupDir = path.join(__dirname, 'test-backups');
  const restoreDir = path.join(__dirname, 'test-restore-data');

  try {
    // --- Test 1: 创建备份 ---
    console.log('Test 1: Create backup');
    const result = await createBackup({
      dshHome: testDir,
      profileDir: testDir,
      profileName: 'test-profile',
      backupDir,
      includeSessions: true,
      includeAttachments: true,
    });
    log('createBackup', result.ok, `created ${result.path} (${result.fileCount} files, ${result.totalBytes} bytes)`);

    // 验证 manifest
    const manifest = readManifest(result.path);
    log('manifest', manifest.formatVersion === 1 && manifest.fileCount === result.fileCount,
      `formatVersion=${manifest.formatVersion}, fileCount=${manifest.fileCount}`);
    log('manifest-encrypted', manifest.encrypted === false, 'should be unencrypted');

    // 验证 node_modules 被跳过
    const skippedNodeModules = manifest.skipped.some((s) => s.startsWith('node_modules'));
    log('skip-node_modules', skippedNodeModules, 'node_modules should be in skipped list');

    // 验证每个文件的 sha256 不为空
    const allHashesValid = manifest.files.every((f) => f.sha256 && f.sha256.length === 64);
    log('sha256-valid', allHashesValid, `${manifest.files.length} files have valid hashes`);

    console.log();

    // --- Test 2: 列出备份 ---
    console.log('Test 2: List backups');
    const backups = listBackups(backupDir);
    log('listBackups', backups.length === 1, `found ${backups.length} backup(s)`);
    if (backups.length > 0) {
      log('backup-item', backups[0].encrypted === false, `name=${backups[0].name}`);
    }
    console.log();

    // --- Test 3: 恢复备份（dryRun） ---
    console.log('Test 3: Restore backup (dryRun)');
    const dryResult = await restoreBackup({
      backupPath: result.path,
      targetDir: restoreDir,
      dryRun: true,
      createSnapshot: false,
    });
    log('dryRun-ok', dryResult.ok && dryResult.planned && dryResult.planned.length > 0,
      `planned ${dryResult.planned?.length} files, errors=${dryResult.errors.length}`);
    console.log();

    // --- Test 4: 恢复备份（实际写入） ---
    console.log('Test 4: Restore backup (actual)');
    const restoreResult = await restoreBackup({
      backupPath: result.path,
      targetDir: restoreDir,
      createSnapshot: false,
    });
    log('restore-ok', restoreResult.ok, `${restoreResult.fileCount} files written, errors=${restoreResult.errors.length}`);

    // 验证恢复文件存在
    const restoredFiles = [
      'test1.txt',
      'test2.txt',
      'subdir/test3.txt',
    ];
    for (const file of restoredFiles) {
      const restoredPath = path.join(restoreDir, file);
      const exists = fs.existsSync(restoredPath);
      log(`restore-${file}`, exists, exists ? 'file exists' : 'file missing');
    }
    console.log();

    // --- Test 4b: 覆盖只读文件（DSH 的 attachments 对象都是只读的） ---
    console.log('Test 4b: Restore over a read-only file');
    const readOnlyTarget = path.join(restoreDir, 'test1.txt');
    fs.writeFileSync(readOnlyTarget, 'stale content');
    fs.chmodSync(readOnlyTarget, 0o444);
    const readOnlyBefore = (fs.statSync(readOnlyTarget).mode & 0o200) === 0;
    log('read-only-prep', readOnlyBefore, `mode=${(fs.statSync(readOnlyTarget).mode & 0o777).toString(8)}`);

    const overReadOnly = await restoreBackup({
      backupPath: result.path,
      targetDir: restoreDir,
      createSnapshot: false,
    });
    log('restore-over-readonly-ok', overReadOnly.ok, `${overReadOnly.fileCount} files, message=${overReadOnly.message}`);
    const overwritten = fs.existsSync(readOnlyTarget) ? fs.readFileSync(readOnlyTarget, 'utf8') : '';
    log('readonly-content-replaced', overwritten === 'Test file 1', `content="${overwritten}"`);
    const stillReadOnly = (fs.statSync(readOnlyTarget).mode & 0o200) === 0;
    log('readonly-attribute-kept', stillReadOnly, `mode=${(fs.statSync(readOnlyTarget).mode & 0o777).toString(8)}`);
    fs.chmodSync(readOnlyTarget, 0o666);
    console.log();

    // --- Test 5: 加密备份 ---
    console.log('Test 5: Encrypted backup');
    const encDir = path.join(__dirname, 'test-enc-backups');
    const encResult = await createBackup({
      dshHome: testDir,
      profileDir: testDir,
      profileName: 'test-profile',
      backupDir: encDir,
      password: 'test-password-123',
    });
    log('enc-create', encResult.ok && encResult.encrypted && encResult.path.endsWith('.zip.enc'),
      `created ${encResult.path}`);

    // 验证 .enc 文件可以被解密并读取 manifest
    const encManifest = readManifest(encResult.path, 'test-password-123');
    log('enc-manifest', encManifest.encrypted === true && encManifest.fileCount === result.fileCount,
      `encrypted=${encManifest.encrypted}, fileCount=${encManifest.fileCount}`);

    // 验证错误密码被拒绝
    try {
      readManifest(encResult.path, 'wrong-password');
      log('enc-wrong-password', false, 'should have thrown');
    } catch (err: any) {
      log('enc-wrong-password', /not a DSH backup|unable to authenticate|bad decrypt|HMAC mismatch|wrong password/i.test(err.message),
        'correctly rejected wrong password');
    }

    // 验证加密备份的恢复
    const encRestoreDir = path.join(__dirname, 'test-enc-restore-data');
    const encRestoreResult = await restoreBackup({
      backupPath: encResult.path,
      targetDir: encRestoreDir,
      password: 'test-password-123',
      createSnapshot: false,
    });
    log('enc-restore', encRestoreResult.ok, `${encRestoreResult.fileCount} files restored`);

    // 验证恢复内容
    const encFile = fs.readFileSync(path.join(encRestoreDir, 'test1.txt'), 'utf8');
    log('enc-restore-content', encFile === 'Test file 1', `content="${encFile}"`);

    console.log();

    // --- Test 6: 错误密码恢复 ---
    console.log('Test 6: Encrypted restore with wrong password');
    const wrongRestoreResult = await restoreBackup({
      backupPath: encResult.path,
      targetDir: path.join(__dirname, 'test-wrong-restore'),
      password: 'wrong-password',
      createSnapshot: false,
    });
    log('wrong-password', !wrongRestoreResult.ok, `error: ${wrongRestoreResult.message}`);
    console.log();

    // --- Test 7: 额外排除 ---
    console.log('Test 7: Extra exclude patterns');
    const excludeDir = path.join(__dirname, 'test-exclude-backups');
    const excludeResult = await createBackup({
      dshHome: testDir,
      profileDir: testDir,
      profileName: 'test-profile',
      backupDir: excludeDir,
      excludePatterns: ['subdir'],
    });
    const excludeManifest = readManifest(excludeResult.path);
    const hasSubdir = excludeManifest.files.some((f) => f.path.startsWith('subdir/'));
    log('exclude-subdir', !hasSubdir, `files: ${excludeManifest.files.map((f) => f.path).join(', ')}`);
    console.log();

    // --- Test 8: 密码长度校验 ---
    console.log('Test 8: Password length validation');
    try {
      await createBackup({
        dshHome: testDir,
        profileDir: testDir,
        profileName: 'test-profile',
        backupDir: path.join(__dirname, 'test-short-pw'),
        password: 'abc', // 3 chars < 4
      });
      log('short-password', false, 'should have thrown');
    } catch (err: any) {
      log('short-password', err.message.includes('at least 4'), `error: ${err.message}`);
    }
    console.log();

    // --- Test 9: 不存在的 dshHome ---
    console.log('Test 9: Non-existent dshHome');
    try {
      await createBackup({
        dshHome: '/nonexistent/path/that/does/not/exist',
      });
      log('no-dsh-home', false, 'should have thrown');
    } catch (err: any) {
      log('no-dsh-home', err.message.includes('not found'), `error: ${err.message}`);
    }
    console.log();

    // --- Test 10: 空目录（无文件可备份） ---
    console.log('Test 10: Empty directory (no files to back up)');
    const emptyDir = path.join(__dirname, 'test-empty-data');
    fs.mkdirSync(emptyDir, { recursive: true });
    try {
      await createBackup({
        dshHome: emptyDir,
        profileDir: emptyDir,
        profileName: 'test-profile',
        backupDir: path.join(__dirname, 'test-empty-backups'),
      });
      log('empty-dir', false, 'should have thrown');
    } catch (err: any) {
      log('empty-dir', err.message.includes('nothing to back up'), `error: ${err.message}`);
    }
    fs.rmSync(emptyDir, { recursive: true, force: true });
    console.log();

    // --- Test 11: 插件文件（node_modules）只有完整备份才会打包 ---
    console.log('Test 11: Plugin files in normal vs full backup');
    const pluginHome = path.join(__dirname, 'test-plugin-home');
    cleanupTestDirectory(pluginHome);
    fs.mkdirSync(path.join(pluginHome, 'profiles/desktop/node_modules/demo-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginHome, 'profiles/desktop/package.json'),
      JSON.stringify({ name: 'desktop', dependencies: { 'demo-plugin': '1.0.0' } }),
    );
    fs.writeFileSync(
      path.join(pluginHome, 'profiles/desktop/node_modules/demo-plugin/package.json'),
      JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(pluginHome, 'profiles/desktop/node_modules/demo-plugin/index.js'), 'export const ok = true;');
    fs.writeFileSync(path.join(pluginHome, 'settings.json'), '{}');

    const pluginNormal = await createBackup({
      dshHome: pluginHome,
      backupDir: path.join(__dirname, 'test-plugin-normal'),
    });
    const pluginFull = await createFullBackup({
      dshHome: pluginHome,
      backupDir: path.join(__dirname, 'test-plugin-full'),
      includeEverything: true,
    });
    const normalNames = openArchive(pluginNormal.path).getEntries().map((entry) => entry.entryName);
    const fullNames = openArchive(pluginFull.path).getEntries().map((entry) => entry.entryName);
    log(
      'normal-backup-excludes-node-modules',
      !normalNames.some((name) => name.includes('node_modules')),
      `normal entries=${normalNames.length}`,
    );
    log(
      'full-backup-includes-node-modules',
      fullNames.some((name) => name.includes('node_modules/demo-plugin/index.js')),
      `full entries=${fullNames.length}`,
    );
    log(
      'normal-manifest-lists-plugins',
      (pluginNormal.manifest.plugins ?? []).some((plugin) => plugin.name === 'demo-plugin' && plugin.version === '1.0.0'),
      `plugins=${(pluginNormal.manifest.plugins ?? []).length}`,
    );
    log('normal-manifest-flags-node-modules', pluginNormal.manifest.includedNodeModules === false);
    log('full-manifest-flags-node-modules', pluginFull.manifest.includedNodeModules === true);
    log(
      'full-note-mentions-plugins',
      /node_modules/.test(pluginFull.note) && /已打包/.test(pluginFull.note),
      pluginFull.note,
    );

    // 恢复一般备份后必须提醒“插件代码没恢复、需要 pnpm install”
    const hintTarget = path.join(__dirname, 'test-plugin-restore');
    cleanupTestDirectory(hintTarget);
    const hinted = await restoreBackup({
      backupPath: pluginNormal.path,
      targetDir: hintTarget,
      createSnapshot: false,
    });
    log('restore-ok-plugin-home', hinted.ok, hinted.message);
    log(
      'restore-hint-install-plugins',
      Array.isArray(hinted.hints) && hinted.hints.some((hint) => /pnpm install/.test(hint)),
      (hinted.hints ?? []).join(' / ') || '(no hints)',
    );
    cleanupTestDirectory(pluginHome);
    cleanupTestDirectory(path.join(__dirname, 'test-plugin-normal'));
    cleanupTestDirectory(path.join(__dirname, 'test-plugin-full'));
    cleanupTestDirectory(hintTarget);
    console.log();

    // --- Test 12: 一般备份可选择把 node_modules 一起打包 ---
    console.log('Test 12: Normal backup with includeNodeModules');
    const optHome = path.join(__dirname, 'test-opt-home');
    cleanupTestDirectory(optHome);
    fs.mkdirSync(path.join(optHome, 'profiles/desktop/node_modules/demo-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(optHome, 'profiles/desktop/node_modules/demo-plugin/package.json'),
      JSON.stringify({ name: 'demo-plugin', version: '2.0.0' }),
    );
    fs.writeFileSync(path.join(optHome, 'profiles/desktop/node_modules/demo-plugin/index.js'), 'export const v = 2;');
    fs.writeFileSync(path.join(optHome, 'settings.json'), '{}');
    const optResult = await createBackup({
      dshHome: optHome,
      backupDir: path.join(__dirname, 'test-opt-backups'),
      includeNodeModules: true,
    });
    const optNames = openArchive(optResult.path).getEntries().map((entry) => entry.entryName);
    log(
      'opt-backup-includes-plugins',
      optNames.some((name) => name.includes('node_modules/demo-plugin/index.js')),
      `entries=${optNames.length}`,
    );
    log('opt-manifest-flags-node-modules', optResult.manifest.includedNodeModules === true);
    cleanupTestDirectory(optHome);
    cleanupTestDirectory(path.join(__dirname, 'test-opt-backups'));
    console.log();

    // --- Test 13: 恢复时把旧 home / 旧用户名路径改写为目标路径 ---
    console.log('Test 13: Restore rewrites absolute paths');
    const rwSource = path.join(__dirname, 'test-rw-src');
    const rwTarget = path.join(__dirname, 'test-rw-dst');
    const rwTargetKeep = path.join(__dirname, 'test-rw-keep');
    cleanupTestDirectory(rwSource);
    cleanupTestDirectory(rwTarget);
    cleanupTestDirectory(rwTargetKeep);
    fs.mkdirSync(path.join(rwSource, 'storages'), { recursive: true });
    const workspacePathInBackup = path.join(rwSource, 'Documents', 'my-workspace');
    fs.writeFileSync(
      path.join(rwSource, 'storages', 'workspace.json'),
      JSON.stringify({ tables: { workspaces: { id1: { path: workspacePathInBackup } } } }, null, 2),
    );
    fs.writeFileSync(path.join(rwSource, 'settings.json'), '{}');
    const rwBackup = await createBackup({
      dshHome: rwSource,
      backupDir: path.join(__dirname, 'test-rw-backups'),
    });
    const rwRestored = await restoreBackup({
      backupPath: rwBackup.path,
      targetDir: rwTarget,
      createSnapshot: false,
    });
    log('rewrite-restore-ok', rwRestored.ok, rwRestored.message);
    const rewrittenText = fs.readFileSync(path.join(rwTarget, 'storages', 'workspace.json'), 'utf8');
    log(
      'rewrite-target-path-present',
      rewrittenText.includes(rwTarget.replace(/\\/g, '\\\\')) || rewrittenText.includes(rwTarget),
      rewrittenText.replace(/\s+/g, ' ').slice(0, 160),
    );
    log('rewrite-old-path-gone', !rewrittenText.includes(workspacePathInBackup));
    log(
      'rewrite-summary-reported',
      Boolean(rwRestored.pathRewrites && rwRestored.pathRewrites.files >= 1),
      JSON.stringify(rwRestored.pathRewrites ?? null),
    );

    const rwKept = await restoreBackup({
      backupPath: rwBackup.path,
      targetDir: rwTargetKeep,
      createSnapshot: false,
      rewritePaths: false,
    });
    const keptText = fs.readFileSync(path.join(rwTargetKeep, 'storages', 'workspace.json'), 'utf8');
    // JSON 里反斜杠是转义的，比较时用转义后的写法
    const escapedOriginal = workspacePathInBackup.replace(/\\/g, '\\\\');
    log('rewrite-disabled-keeps-original', rwKept.ok && keptText.includes(escapedOriginal), keptText.replace(/\s+/g, ' ').slice(0, 120));
    cleanupTestDirectory(rwSource);
    cleanupTestDirectory(rwTarget);
    cleanupTestDirectory(rwTargetKeep);
    cleanupTestDirectory(path.join(__dirname, 'test-rw-backups'));
    console.log();

    // --- Test 14: 工作区文件打包 + 恢复时落到改写后的路径 ---
    console.log('Test 14: Workspace files are packed and restored');
    const wsBase = path.join(__dirname, 'test-ws-src');
    const wsBase2 = path.join(__dirname, 'test-ws-dst');
    cleanupTestDirectory(wsBase);
    cleanupTestDirectory(wsBase2);
    const wsHome = path.join(wsBase, 'home');
    const wsDir = path.join(wsBase, 'ws');
    fs.mkdirSync(path.join(wsHome, 'storages'), { recursive: true });
    fs.mkdirSync(path.join(wsDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'a.txt'), 'workspace file');
    fs.writeFileSync(path.join(wsDir, 'sub', 'b.js'), 'export const y = 2;');
    fs.writeFileSync(
      path.join(wsHome, 'storages', 'workspace.json'),
      JSON.stringify({ tables: { workspaces: { 'ws-1': { path: wsDir, title: 'demo-ws' } } } }),
    );
    fs.writeFileSync(path.join(wsHome, 'settings.json'), '{}');
    const wsBackup = await createBackup({
      dshHome: wsHome,
      backupDir: path.join(__dirname, 'test-ws-backups'),
      includeWorkspaces: true,
    });
    const wsNames = openArchive(wsBackup.path).getEntries().map((entry) => entry.entryName);
    log('workspace-packed', wsNames.some((name) => name.startsWith('__workspaces__/ws-1/')), `entries=${wsNames.length}`);
    log(
      'workspace-manifest',
      wsBackup.manifest.includedWorkspaces === true && (wsBackup.manifest.workspaceRoots ?? []).length === 1,
      JSON.stringify(wsBackup.manifest.workspaceRoots ?? null),
    );
    const wsTarget = path.join(wsBase2, 'home');
    const wsRestored = await restoreBackup({ backupPath: wsBackup.path, targetDir: wsTarget, createSnapshot: false });
    log('workspace-restore-ok', wsRestored.ok, wsRestored.message);
    const restoredWsDir = path.join(wsBase2, 'ws');
    log(
      'workspace-files-landed',
      fs.existsSync(path.join(restoredWsDir, 'a.txt'))
        && fs.readFileSync(path.join(restoredWsDir, 'sub', 'b.js'), 'utf8').includes('y = 2'),
      restoredWsDir,
    );
    log(
      'workspace-restore-reported',
      Array.isArray(wsRestored.workspaceRestores) && wsRestored.workspaceRestores[0].files >= 2,
      JSON.stringify(wsRestored.workspaceRestores ?? null),
    );
    log('workspace-stage-cleaned', !fs.existsSync(path.join(wsTarget, '__workspaces__')));
    cleanupTestDirectory(wsBase);
    cleanupTestDirectory(wsBase2);
    cleanupTestDirectory(path.join(__dirname, 'test-ws-backups'));
    console.log();

  } catch (error) {
    console.error('Test suite crashed:', error);
    failed += 1;
  } finally {
    // 清理
    cleanupTestDirectory(testDir);
    cleanupTestDirectory(restoreDir);
    cleanupTestDirectory(backupDir);
    cleanupTestDirectory(path.join(__dirname, 'test-enc-backups'));
    cleanupTestDirectory(path.join(__dirname, 'test-enc-restore-data'));
    cleanupTestDirectory(path.join(__dirname, 'test-wrong-restore'));
    cleanupTestDirectory(path.join(__dirname, 'test-exclude-backups'));
    cleanupTestDirectory(path.join(__dirname, 'test-short-pw'));
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

// 运行测试
runTests();
