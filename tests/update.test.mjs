import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mod = await import('../lib/update.js');
const { compareVersions, fetchLatestVersion, ensureReleaseAgeExclude, backupAndUpdate, installedPluginDir, profileDirOf } = mod;

const checks = [];
const check = (label, ok, extra = '') => {
  checks.push({ label, ok: Boolean(ok), extra });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
};

// 1. semver
check('compare 0.3.3 > 0.3.2', compareVersions('0.3.3', '0.3.2') === 1);
check('compare 0.3.2 < 0.3.10', compareVersions('0.3.2', '0.3.10') === -1);
check('compare 0.3.2 == 0.3.2', compareVersions('0.3.2', '0.3.2') === 0);
check('compare 0.3.3-beta < 0.3.3', compareVersions('0.3.3-beta', '0.3.3') === -1);

// 2. plugin dir 推导
const dir = installedPluginDir();
check('installedPluginDir 指向插件根', fs.existsSync(path.join(dir, 'package.json')), dir);
check('profileDirOf 从 node_modules 上溯', profileDirOf(path.join('X:', 'profiles', 'desktop', 'node_modules', 'dsh-backup-rescue')).endsWith(path.join('profiles', 'desktop')));

// 3. registry
const latest = await fetchLatestVersion();
check('fetchLatestVersion', /^\d+\.\d+\.\d+/.test(latest.version), JSON.stringify(latest));

// 4. ensureReleaseAgeExclude（临时 profile）
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshprof-'));
fs.writeFileSync(path.join(tmpProfile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - dsh-backup-rescue@0.3.1\n');
const patched = ensureReleaseAgeExclude(tmpProfile, '0.3.3');
const yaml = fs.readFileSync(path.join(tmpProfile, 'pnpm-workspace.yaml'), 'utf8');
check('exclude 追加 0.3.3', patched && yaml.includes('dsh-backup-rescue@0.3.3'), yaml.replace(/\n/g, ' | '));
const again = ensureReleaseAgeExclude(tmpProfile, '0.3.3');
check('exclude 幂等', again === null && fs.readFileSync(path.join(tmpProfile, 'pnpm-workspace.yaml'), 'utf8').match(/0\.3\.3/g).length === 1);
// 没有 exclude 列表时自动补
fs.writeFileSync(path.join(tmpProfile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nminimumReleaseAge: 1440\n');
ensureReleaseAgeExclude(tmpProfile, '0.3.4');
check('无 exclude 列表时自动新增', /minimumReleaseAgeExclude:\s*\n\s+- dsh-backup-rescue@0\.3\.4/.test(fs.readFileSync(path.join(tmpProfile, 'pnpm-workspace.yaml'), 'utf8')));
fs.rmSync(tmpProfile, { recursive: true, force: true });

// 5. 端到端：临时 dshHome，先备份再查版本（本地 0.3.3 > registry 时不应安装）
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshupdate-'));
fs.mkdirSync(path.join(home, 'skills', 'demo'), { recursive: true });
fs.writeFileSync(path.join(home, 'skills', 'demo', 'SKILL.md'), '# demo');
const result = await backupAndUpdate({ dshHome: home, profileDir: tmpProfileX(), profileName: 'desktop', backupDir: path.join(home, 'exports') });
function tmpProfileX() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshprofx-'));
}
check('backupAndUpdate ok', result.ok === true, `updated=${result.updated} ${result.oldVersion}->${result.newVersion}`);
check('备份文件夹生成', Boolean(result.backupFolder && fs.existsSync(result.backupFolder)), result.backupFolder ?? '');
check('备份文件夹里有同名 bat', Boolean(result.backupFolder && fs.existsSync(path.join(result.backupFolder, path.basename(result.backupFolder) + '.bat'))));
check('本地版本 >= registry 时不安装', result.updated === false, result.message);
check('日志非空', Array.isArray(result.log) && result.log.length > 0, (result.log ?? []).slice(0, 3).join(' / '));
fs.rmSync(home, { recursive: true, force: true });
try { fs.rmSync(result.backupFolder ? path.dirname(path.dirname(result.backupFolder)) : '', { recursive: true, force: true }); } catch {}

console.log(`\n=== ${checks.filter((c) => c.ok).length} passed, ${checks.filter((c) => !c.ok).length} failed ===`);
process.exit(checks.some((c) => !c.ok) ? 1 : 0);
