import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshfake-'));
process.env.DSH_HOME = home;
fs.mkdirSync(path.join(home, 'settings'), { recursive: true });
fs.writeFileSync(path.join(home, 'settings', 'settings.json'), JSON.stringify({ locale: 'zh' }));
fs.mkdirSync(path.join(home, 'profiles', 'desktop', 'plugins'), { recursive: true });
fs.writeFileSync(path.join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'desktop' }));

const mod = await import('../lib/routes.js');
const server = { defs: [], register(route) { this.defs.push(route); return () => {}; } };
const ctx = {
  inject(names, callback) {
    const injected = { effect: (fn) => fn() };
    for (const name of names) injected[name] = name === 'webServer' ? server : undefined;
    callback(injected);
  },
};
const mounted = mod.registerRoutes(ctx, (m) => console.log('LOG', m));
console.log('mounted:', mounted.length);

function fakeReq(method, body) {
  const buf = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of buf) yield c; },
  };
}
function fakeRes() {
  return {
    statusCode: 0, headers: null, body: '',
    writeHead(s, h) { this.statusCode = s; this.headers = h; },
    end(p) { this.body = p ?? ''; },
  };
}

const byPath = (p) => server.defs.find((d) => d.path === p);

let res = fakeRes();
await byPath('/api/dsh-backup-rescue/status').handler(fakeReq('GET'), res);
console.log('status', res.statusCode, res.body.slice(0, 160));

res = fakeRes();
await byPath('/api/dsh-backup-rescue/create').handler(fakeReq('POST', {}), res);
console.log('create', res.statusCode, res.body.slice(0, 200));
const created = JSON.parse(res.body);

res = fakeRes();
await byPath('/api/dsh-backup-rescue/status').handler(fakeReq('GET'), res);
console.log('status2 count', JSON.parse(res.body).backupCount);

res = fakeRes();
await byPath('/api/dsh-backup-rescue/restore').handler(fakeReq('POST', { backupPath: created.archive, dryRun: true }), res);
console.log('restore(dry)', res.statusCode, res.body.slice(0, 200));

res = fakeRes();
await byPath('/api/dsh-backup-rescue/create').handler(fakeReq('POST', { password: 'pw123456' }), res);
console.log('create-enc', res.statusCode, JSON.parse(res.body).encrypted);

// ---- 0.4.0：设置（备份位置 + 自动备份）----
res = fakeRes();
await byPath('/api/dsh-backup-rescue/settings').handler(fakeReq('GET'), res);
const settingsBefore = JSON.parse(res.body);
console.log('settings(GET)', res.statusCode, 'backupDir=', settingsBefore.backupDir, 'auto=', settingsBefore.settings.autoBackup);

const newDir = path.join(home, 'elsewhere', 'backups');
res = fakeRes();
await byPath('/api/dsh-backup-rescue/settings').handler(
  fakeReq('POST', { backupDir: newDir, migrate: true, autoBackup: { enabled: true, intervalMinutes: 5, maxBackups: 2 } }),
  res,
);
const settingsAfter = JSON.parse(res.body);
console.log('settings(POST)', res.statusCode, 'ok=', settingsAfter.ok, 'dir=', settingsAfter.backupDir);
console.log('migration:', settingsAfter.migration && settingsAfter.migration.message);
console.log('autoBackup state:', JSON.stringify(settingsAfter.autoBackup));
if (settingsAfter.migration && settingsAfter.migration.fileCount === 0) {
  console.error('FAIL: 迁移没有搬走任何文件');
  process.exitCode = 1;
}

res = fakeRes();
await byPath('/api/dsh-backup-rescue/status').handler(fakeReq('GET'), res);
const movedStatus = JSON.parse(res.body);
console.log('status after migrate: dir=', movedStatus.backupDir, 'count=', movedStatus.backupCount, 'isDefault=', movedStatus.isDefaultBackupDir);
if (movedStatus.backupCount < 2) {
  console.error('FAIL: 迁移后备份丢了');
  process.exitCode = 1;
}

// 相对路径必须被拒
res = fakeRes();
await byPath('/api/dsh-backup-rescue/settings').handler(fakeReq('POST', { backupDir: 'relative/dir' }), res);
console.log('settings(POST relative)', res.statusCode, res.body.slice(0, 120));
if (res.statusCode !== 400) {
  console.error('FAIL: 相对路径没被拒绝');
  process.exitCode = 1;
}

// 保留策略：把上限压到 1 份，应删掉更早的普通备份
res = fakeRes();
await byPath('/api/dsh-backup-rescue/prune').handler(fakeReq('POST', { maxBackups: 1 }), res);
const pruned = JSON.parse(res.body);
console.log('prune', res.statusCode, pruned.message, 'removed=', pruned.removed.length);
if (pruned.removed.length < 1) {
  console.error('FAIL: prune 没有删掉任何备份');
  process.exitCode = 1;
}

// 禁止跨站/非回环
res = fakeRes();
await byPath('/api/dsh-backup-rescue/settings').handler({ ...fakeReq('GET'), headers: { 'sec-fetch-site': 'cross-site' } }, res);
console.log('settings(GET cross-site)', res.statusCode);
if (res.statusCode !== 403) {
  console.error('FAIL: cross-site 请求没有被拒绝');
  process.exitCode = 1;
}

fs.rmSync(home, { recursive: true, force: true });

