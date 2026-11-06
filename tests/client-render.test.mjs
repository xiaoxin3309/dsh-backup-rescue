// 临时：在 node 里用 React 桩执行 client.js，验证设置页组件能否渲染（不抛 ReferenceError）
import { readFileSync } from 'node:fs';

const target = process.argv[2];
const src = readFileSync(target, 'utf8');

let def = null;
globalThis.window = { __ModuleLoader__: { load(d) { def = d; } }, confirm: () => true };
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

new Function(src)();

function makeReact(stateValue) {
  let i = 0;
  return {
    createElement: (t, p, ...c) => ({ t, p, c }),
    useState: () => {
      const idx = i++;
      const init = idx === 0 ? stateValue : idx === 1 ? '' : idx === 2 ? '' : idx === 3 ? '' : idx === 4 ? '' : null;
      return [init, () => {}];
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    Fragment: Symbol.for('Fragment'),
  };
}

const mod = def.factory((name) => {
  if (name === 'react') return makeReact(null);
  throw new Error('unexpected require: ' + name);
});

let spec = null;
let comp = null;
const ctx = {
  slots: {
    inject: (_name, cb) => cb(),
    register: (s, c) => { spec = s; comp = c; return () => {}; },
  },
};
mod.apply(ctx);

function count(node) {
  if (node === null || node === undefined) return 0;
  if (Array.isArray(node)) return node.reduce((n, x) => n + count(x), 0);
  if (typeof node !== 'object') return 1;
  return 1 + count(node.c);
}

const results = {};
const stamp = '2026-10-22T10-15-00-000Z';
const baseState = {
  pluginVersion: '0.4.0',
  backupDir: 'C:\\Users\\me\\.dsh\\dsh-backup-rescue\\exports',
  defaultBackupDir: 'C:\\Users\\me\\.dsh\\dsh-backup-rescue\\exports',
  isDefaultBackupDir: true,
  backupDirs: {
    normal: 'C:\\Users\\me\\.dsh\\dsh-backup-rescue\\exports\\normal',
    full: 'C:\\Users\\me\\.dsh\\dsh-backup-rescue\\exports\\full',
  },
  settings: {
    backupDir: null,
    autoBackup: { enabled: true, intervalMinutes: 30, maxBackups: 5 },
  },
  autoBackup: {
    running: true,
    enabled: true,
    intervalMinutes: 30,
    maxBackups: 5,
    backupDir: 'C:\\Users\\me\\.dsh\\dsh-backup-rescue\\exports',
    nextRunAt: new Date(Date.now() + 600000).toISOString(),
    lastRunAt: new Date().toISOString(),
    lastStatus: 'ok',
    lastBackupPath: `C:\\exports\\normal\\dsh-backup-${stamp}\\dsh-backup-${stamp}.zip`,
    lastPruned: 2,
    lastError: null,
    tickCount: 7,
  },
  backups: [
    {
      path: `C:\\exports\\normal\\dsh-backup-${stamp}\\dsh-backup-${stamp}.zip`,
      folder: `C:\\exports\\normal\\dsh-backup-${stamp}`,
      name: `dsh-backup-${stamp}.zip`,
      kind: 'normal',
      size: 1024,
      createdAt: new Date().toISOString(),
      encrypted: false,
      restoreBat: `C:\\exports\\normal\\dsh-backup-${stamp}\\dsh-backup-${stamp}.bat`,
    },
    {
      // 0.3.2 时代的平铺备份：没有 restoreBat，走「请用 restore.bat」分支
      path: 'C:\\exports\\dsh-backup-full-old.zip.enc',
      folder: 'C:\\exports',
      name: 'dsh-backup-full-old.zip.enc',
      kind: 'full',
      size: 2048,
      createdAt: new Date().toISOString(),
      encrypted: true,
      restoreBat: null,
    },
  ],
};
for (const [label, state] of [
  ['loading(state=null)', null],
  ['loaded(state!=null)', baseState],
  // 自动化关掉时的另一条分支
  [
    'loaded(auto off, custom dir)',
    {
      ...baseState,
      isDefaultBackupDir: false,
      backupDir: 'D:\\DSH-Backups',
      settings: { backupDir: 'D:\\DSH-Backups', autoBackup: { enabled: false, intervalMinutes: 60, maxBackups: 10 } },
      autoBackup: { ...baseState.autoBackup, running: false, enabled: false, lastStatus: 'skipped', lastError: null },
    },
  ],
]) {
  const React = makeReact(state);
  // 重新执行工厂，让组件闭包拿到对应桩
  const m2 = def.factory((n) => (n === 'react' ? React : null));
  let c2 = null;
  m2.apply({ slots: { inject: (_n, cb) => cb(), register: (_s, c) => { c2 = c; return () => {}; } } });
  try {
    const tree = c2({});
    results[label] = { ok: true, nodes: count(tree) };
  } catch (e) {
    results[label] = { ok: false, error: e.message };
  }
}

const failed = Object.entries(results).filter(([, r]) => !r.ok);
console.log(JSON.stringify({ spec, hasComponent: typeof comp, results }, null, 1));
if (failed.length > 0) {
  console.error('render failed:', JSON.stringify(failed));
  process.exit(1);
}
