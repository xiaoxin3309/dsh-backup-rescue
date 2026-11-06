// 端到端测试：加密备份 -> 双击同名 .bat（这里用 cmd 模拟）-> 校验恢复结果
//
// 覆盖：
//  1. 双击一键 bat（无参数）：出现密码提示，输入正确密码后能真正解密并落盘
//  2. restore.bat 配合 DSH_RESTORE_PASSWORD：含引号/空格/& 的密码也能解开
//  3. 密码错误：干净失败（退出码非 0，目标目录不写入任何备份内容）
//  4. 0.4.0 及更早的 DSHBK001 旧格式：被识别并给出可操作提示
//
// 运行：node tests/restore-bat.test.mjs

import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackup, openArchive } from '../lib/backup.js';
import { ENC_MAGIC_V1 } from '../lib/types.js';

let pass = 0;
let fail = 0;
const tempDirs = [];

function log(label, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`);
  }
}

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-restore-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function readAll(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.backup-snapshot') continue;
        walk(full);
      } else {
        out.set(path.relative(root, full).replace(/\\/g, '/'), fs.readFileSync(full));
      }
    }
  };
  walk(root);
  return out;
}

function runBat(batPath, args, env, input) {
  return spawnSync('cmd.exe', ['/c', batPath, ...args], {
    env: {
      ...process.env,
      DSH_RESTORE_NO_PAUSE: '1',
      DSH_RESTORE_SKIP_PROCESS_CHECK: '1',
      DSH_RESTORE_YES: '1',
      ...env,
    },
    input: input === undefined ? undefined : Buffer.from(input, 'utf8'),
    windowsHide: true,
    timeout: 180000,
  });
}

function findRestored(restored, key) {
  const normalized = key.replace(/\\/g, '/');
  const hit = [...restored.keys()].find((k) => k.endsWith(normalized));
  return hit ? restored.get(hit) : null;
}

const SENTINEL = {
  'config.json': JSON.stringify({ hello: 'dsh', n: 42 }),
  'sessions/s1.jsonl': '{"role":"user"}\n{"role":"assistant"}\n',
  '中文目录/说明.txt': '中文内容与 emoji 🚀 也要能原样回来',
  'deep/nested/dir/payload.bin': randomBytes(4096),
};

console.log('== 1. 双击一键 bat，用密码提示解锁（真实用户路径）==');
{
  const dshHome = tmpDir('home');
  const backupDir = tmpDir('backups');
  const target = tmpDir('target');
  writeTree(dshHome, SENTINEL);

  const result = await createBackup({
    dshHome,
    backupDir,
    password: 'simple-pass-123',
    includeSecrets: true,
    includeSessions: true,
    includeAttachments: false,
  });
  log('加密备份已生成', result.ok && result.encrypted, path.basename(result.path));

  const bat = result.restoreBat;
  log('同名一键脚本存在', Boolean(bat) && fs.existsSync(bat), bat ? path.basename(bat) : 'missing');
  if (!bat || !fs.existsSync(bat)) {
    process.exitCode = 1;
  } else {
    const batBytes = fs.readFileSync(bat);
    const text = batBytes.toString('utf8');
    const crlf = (text.match(/\r\n/g) || []).length;
    const lfOnly = (text.match(/(?<!\r)\n/g) || []).length;
    log('一键脚本行尾正确', crlf > 0 && lfOnly === 0, `${crlf} CRLF / ${lfOnly} 裸 LF`);
    log('一键脚本是纯 ASCII', batBytes.every((byte) => byte < 0x80));

    const restoreBat = path.join(path.dirname(bat), 'restore.bat');
    const restoreBytes = fs.readFileSync(restoreBat);
    const restoreText = restoreBytes.toString('utf8');
    const rCrlf = (restoreText.match(/\r\n/g) || []).length;
    const rLfOnly = (restoreText.match(/(?<!\r)\n/g) || []).length;
    log('restore.bat 是 CRLF 行尾', rCrlf > 100 && rLfOnly === 0, `${rCrlf} CRLF / ${rLfOnly} 裸 LF`);
    log('restore.bat 是纯 ASCII（无 BOM、无多字节）', restoreBytes.every((byte) => byte < 0x80));

    // 不出声地双击：不传任何参数，只把密码喂给 stdin
    const before = new Set(fs.readdirSync(os.tmpdir()));
    const run = runBat(bat, [], { DSH_RESTORE_TARGET: target }, 'simple-pass-123\r\n');
    const stdout = run.stdout.toString('utf8');
    log('脚本退出码 0', run.status === 0, `status=${run.status}`);
    log('出现了密码提示', /password/i.test(stdout));
    if (run.status !== 0) console.log('---- stdout ----\n' + stdout.slice(-2500) + '\n----------------');

    const restored = readAll(target);
    for (const [key, value] of Object.entries(SENTINEL)) {
      const got = findRestored(restored, key);
      log(`恢复内容一致: ${key}`, Boolean(got) && got.equals(Buffer.from(value)), got ? 'ok' : 'missing');
    }
    const tempLeft = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dsh-restore-') && !before.has(n));
    log('解密临时目录已清理', tempLeft.length === 0, tempLeft.join(',') || 'none');
  }
}

console.log('== 2. restore.bat + DSH_RESTORE_PASSWORD（含引号/空格/&）==');
{
  const dshHome = tmpDir('home2');
  const backupDir = tmpDir('backups2');
  const target = tmpDir('target2');
  writeTree(dshHome, { 'a.txt': 'x' });
  const tricky = 'pa ss"w0rd&?<>|';
  const result = await createBackup({ dshHome, backupDir, password: tricky, includeSecrets: true });

  const restore = path.join(path.dirname(result.path), 'restore.bat');
  log('restore.bat 已随备份生成', fs.existsSync(restore));
  const run = runBat(restore, [result.path], { DSH_RESTORE_TARGET: target, DSH_RESTORE_PASSWORD: tricky });
  log('特殊字符密码解开了', run.status === 0, `status=${run.status}`);
  if (run.status !== 0) console.log('---- stdout ----\n' + run.stdout.toString('utf8').slice(-2500) + '\n----------------');
  const restored = readAll(target);
  log('特殊密码恢复的内容正确', findRestored(restored, 'a.txt')?.toString() === 'x');
}

console.log('== 3. 密码错误：干净失败 ==');
{
  const dshHome = tmpDir('home3');
  const backupDir = tmpDir('backups3');
  const target = tmpDir('target3');
  writeTree(dshHome, { 'a.txt': 'x' });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');

  const result = await createBackup({ dshHome, backupDir, password: 'right-password', includeSecrets: true });
  const restore = path.join(path.dirname(result.path), 'restore.bat');
  const run = runBat(restore, [result.path], { DSH_RESTORE_TARGET: target, DSH_RESTORE_PASSWORD: 'wrong-password' });
  log('退出码非 0', run.status !== 0, `status=${run.status}`);
  const restored = readAll(target);
  log('没有写入备份内容', !findRestored(restored, 'a.txt'));
  log('原有文件保持原样', restored.size === 1 && restored.get('keep.txt').toString() === 'keep');
}

console.log('== 4. 目标里已有只读文件（模拟 attachments 对象）==');
{
  const dshHome = tmpDir('home5');
  const backupDir = tmpDir('backups5');
  const target = tmpDir('target5');
  writeTree(dshHome, { 'attachments/v1/objects/aa/obj1': 'new-content' });

  // DSH 把 attachments 对象存成只读文件；覆盖前必须放开属性，写完还原
  const existing = path.join(target, 'attachments/v1/objects/aa/obj1');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, 'old-content');
  fs.chmodSync(existing, 0o444);

  const result = await createBackup({ dshHome, backupDir, includeSecrets: true });
  const bat = result.restoreBat;
  const run = runBat(bat, [], { DSH_RESTORE_TARGET: target });
  log('只读目标下恢复成功', run.status === 0, `status=${run.status}`);
  if (run.status !== 0) console.log('---- stdout ----\n' + run.stdout.toString('utf8').slice(-2500) + '\n----------------');
  const restored = readAll(target);
  const got = findRestored(restored, 'attachments/v1/objects/aa/obj1');
  log('只读文件内容被替换', got?.toString() === 'new-content', got ? got.toString() : 'missing');
  const mode = fs.statSync(existing).mode;
  log('只读属性被保留', (mode & 0o200) === 0, `mode=${(mode & 0o777).toString(8)}`);
  fs.chmodSync(existing, 0o666);
}

console.log('== 5. 恢复时改写绝对路径（换机器/换用户名）==');
{
  const dshHome = tmpDir('home6');
  const backupDir = tmpDir('backups6');
  const target = tmpDir('target6');
  const insidePath = path.join(dshHome, 'Documents', 'my-workspace');
  fs.mkdirSync(path.join(dshHome, 'storages'), { recursive: true });
  fs.writeFileSync(
    path.join(dshHome, 'storages', 'workspace.json'),
    JSON.stringify({ tables: { workspaces: { id1: { path: insidePath } } } }, null, 2),
  );
  fs.writeFileSync(path.join(dshHome, 'settings.json'), '{}');

  const result = await createBackup({ dshHome, backupDir, includeSecrets: true });
  const bat = result.restoreBat;
  const run = runBat(bat, [], { DSH_RESTORE_TARGET: target });
  const batStdout = run.stdout.toString('utf8');
  log('路径改写后恢复成功', run.status === 0, `status=${run.status}`);
  if (run.status !== 0) console.log('---- stdout ----\n' + batStdout.slice(-2500) + '\n----------------');
  log('脚本报告了改写', /path rewrite/i.test(batStdout), (batStdout.match(/\[OK\] path rewrite[^\r\n]*/) || ['(none)'])[0]);

  const restored = readAll(target);
  const ws = findRestored(restored, 'storages/workspace.json')?.toString('utf8') ?? '';
  const expected = path.join(target, 'Documents', 'my-workspace');
  log('新路径已写入', ws.includes(expected.replace(/\\/g, '\\\\')), ws.replace(/\s+/g, ' ').slice(0, 140));
  log('旧路径已消失', !ws.includes(insidePath.replace(/\\/g, '\\\\')));
}

console.log('== 6. 工作区文件（打包在 __workspaces__ 里，恢复时搬回真实路径）==');
{
  const base = tmpDir('ws6');
  const base2 = tmpDir('ws6b');
  const dshHome = path.join(base, 'home');
  const wsDir = path.join(base, 'ws');
  const target = path.join(base2, 'home');
  fs.mkdirSync(path.join(dshHome, 'storages'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'a.txt'), 'workspace file');
  fs.writeFileSync(path.join(wsDir, 'sub', 'b.js'), 'export const z = 3;');
  fs.writeFileSync(
    path.join(dshHome, 'storages', 'workspace.json'),
    JSON.stringify({ tables: { workspaces: { 'ws-6': { path: wsDir, title: 'ws6demo' } } } }),
  );
  fs.writeFileSync(path.join(dshHome, 'settings.json'), '{}');

  const result = await createBackup({ dshHome, backupDir: path.join(base, 'backups'), includeWorkspaces: true });
  log('备份包含工作区前缀', openArchive(result.path).getEntries().some((entry) => entry.entryName.startsWith('__workspaces__/ws-6/')));

  const run = runBat(result.restoreBat, [], { DSH_RESTORE_TARGET: target });
  const stdout = run.stdout.toString('utf8');
  log('含工作区的备份恢复成功', run.status === 0, `status=${run.status}`);
  if (run.status !== 0) console.log('---- stdout ----\n' + stdout.slice(-2500) + '\n----------------');
  log('脚本报告工作区恢复', /workspace files restored/i.test(stdout), (stdout.match(/\[OK\] workspace files restored[^\r\n]*/) || ['(none)'])[0]);

  const restoredWs = path.join(base2, 'ws');
  const restoredFile = path.join(restoredWs, 'sub', 'b.js');
  log('工作区文件落到改写后的位置', fs.existsSync(restoredFile) && fs.readFileSync(restoredFile, 'utf8').includes('z = 3'), restoredWs);
  log('暂存目录已清理', !fs.existsSync(path.join(target, '__workspaces__')));
}

console.log('== 7. DSHBK001 旧格式：识别并给出提示 ==');
{
  const dir = tmpDir('v1');
  const password = 'oldpass';
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from('legacy-body')), cipher.final()]);
  const archive = path.join(dir, 'dsh-backup-legacy.zip.enc');
  fs.writeFileSync(archive, Buffer.concat([Buffer.from(ENC_MAGIC_V1, 'ascii'), salt, iv, cipher.getAuthTag(), body]));

  // 复制模板到临时目录，避免往插件目录里落临时文件
  const template = new URL('../templates/restore.bat', import.meta.url);
  const bat = path.join(dir, 'restore.bat');
  fs.copyFileSync(template, bat);

  const target = tmpDir('target4');
  const run = runBat(bat, [archive], { DSH_RESTORE_TARGET: target, DSH_RESTORE_PASSWORD: password });
  const stdout = run.stdout.toString('utf8');
  log('识别为旧格式', /DSHBK001|legacy/i.test(stdout), `status=${run.status}`);
}

for (const dir of tempDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exitCode = 1;
