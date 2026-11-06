import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshfake2-'));
fs.mkdirSync(path.join(home, 'skills', 'x'), { recursive: true });
fs.writeFileSync(path.join(home, 'skills', 'x', 'SKILL.md'), 'hi');
const { createBackup, createFullBackup, listBackups } = await import('../lib/backup.js');
const out = await createBackup({ dshHome: home, backupDir: path.join(home, 'dsh-backup-rescue', 'exports') });
console.log('folder =', out.folder);
console.log('restoreBat =', out.restoreBat);
const dir = out.folder;
for (const f of fs.readdirSync(dir)) {
  const st = fs.statSync(path.join(dir, f));
  console.log(String(st.size).padStart(8), f);
}
// 一键 bat 现在与压缩包同名（同目录、同主名）
const stem = path.basename(out.archive).replace(/\.zip(\.enc)?$/i, '');
const bat = path.join(dir, `${stem}.bat`);
if (fs.existsSync(bat)) console.log('--- ' + path.basename(bat) + ' ---\n' + fs.readFileSync(bat, 'utf8'));
else console.log('!! 缺少同名一键 bat:', bat);
const full = await createFullBackup({ dshHome: home, backupDir: path.join(home, 'dsh-backup-rescue', 'exports') });
console.log('full.folder =', full.folder);
console.log('full.restoreBat =', full.restoreBat);
console.log('list =', JSON.stringify(listBackups(path.join(home, 'dsh-backup-rescue', 'exports')).map((i) => ({ name: i.name, kind: i.kind, folder: path.basename(i.folder), bat: i.restoreBat ? path.basename(i.restoreBat) : null })), null, 2));
fs.rmSync(home, { recursive: true, force: true });
