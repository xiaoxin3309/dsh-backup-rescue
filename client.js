/**
 * DSH Backup Plugin — 浏览器端（设置页「备份」分区）。
 *
 * 加载约定（来自宿主文档 templates/decoration 与 @deepseek-ai/dsh-client-modules）：
 *   window.__ModuleLoader__.load({ id, factory(require) { ... return { inject, apply } } })
 * - id 必须等于 package.json 的包名；
 * - React 从浏览器模块表取，禁止自带一份 React；
 * - 模块导出一个 cordis 客户端插件：{ inject: ['slots'], apply(ctx) }；
 * - 通过 ctx.slots.inject(name, () => ctx.slots.register(spec, Component)) 挂到插槽。
 *
 * 本文件刻意不 import 任何 @deepseek-ai/dsh-client-* 包：宿主文档明确要求普通
 * 插件自带控件、只借用主题 CSS 变量，避免被内部 API 变更打崩。
 */

window.__ModuleLoader__.load({
  id: 'dsh-backup-rescue',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = '/api/dsh-backup-rescue';

    function fmtBytes(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes)) return '-';
      const units = ['B', 'KB', 'MB', 'GB'];
      let value = bytes;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
    }

    function fmtTime(iso) {
      if (typeof iso !== 'string') return '-';
      const date = new Date(iso);
      if (isNaN(date.getTime())) return iso;
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    async function request(path, init) {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const message = body && body.message ? body.message : body && body.error ? body.error : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return body;
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0', maxWidth: '860px' },
      title: { margin: 0, fontSize: '16px', fontWeight: 600 },
      hint: { margin: 0, fontSize: '12px', opacity: 0.7, lineHeight: 1.6 },
      card: {
        border: '1px solid rgba(127,127,127,0.28)',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: '12px' },
      key: { opacity: 0.65 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' },
      button: {
        appearance: 'none',
        border: '1px solid rgba(127,127,127,0.4)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '8px',
        padding: '6px 14px',
        fontSize: '13px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      primary: {
        border: '1px solid transparent',
        background: '#247bbf',
        color: '#fff',
        borderRadius: '8px',
        padding: '7px 16px',
        fontSize: '13px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      input: {
        border: '1px solid rgba(127,127,127,0.4)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '8px',
        padding: '6px 10px',
        fontSize: '13px',
        fontFamily: 'inherit',
        minWidth: '180px',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,0.25)', fontWeight: 500, opacity: 0.75 },
      td: { padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,0.12)', verticalAlign: 'middle' },
      ok: { fontSize: '12px', color: '#1a7f37' },
      bad: { fontSize: '12px', color: '#c4342b' },
    };

    function BackupSection() {
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [ok, setOk] = React.useState('');
      const [password, setPassword] = React.useState('');
      /* 普通备份是否连插件文件（node_modules）一起打包 */
      const [includePlugins, setIncludePlugins] = React.useState(false);
      /* 备份是否连同工作区文件 */
      const [includeWorkspaces, setIncludeWorkspaces] = React.useState(false);
      const [updateInfo, setUpdateInfo] = React.useState(null);
      /* 备份位置：null = 没编辑过（显示当前值） */
      const [dirDraft, setDirDraft] = React.useState(null);
      const [migrateOnChange, setMigrateOnChange] = React.useState(true);
      /* 自动备份：null/'' = 没编辑过（显示当前设置） */
      const [autoEnabledDraft, setAutoEnabledDraft] = React.useState(null);
      const [autoIntervalDraft, setAutoIntervalDraft] = React.useState('');
      const [autoMaxDraft, setAutoMaxDraft] = React.useState('');

      const refresh = React.useCallback(async () => {
        try {
          const payload = await request('/status', { method: 'GET' });
          setState(payload);
          setError('');
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
        }
      }, []);

      React.useEffect(() => {
        void refresh();
      }, [refresh]);

      const runBackup = React.useCallback(async () => {
        setBusy('backup');
        setError('');
        setOk('');
        try {
          const body = {};
          if (password) body.password = password;
          if (includePlugins) body.includeNodeModules = true;
          if (includeWorkspaces) body.includeWorkspaces = true;
          const payload = await request('/create', { method: 'POST', body: JSON.stringify(body) });
          const extra = payload.includedNodeModules ? '（含插件文件）' : '';
          setOk(`备份完成${extra}：${payload.archive}（${payload.fileCount} 个文件，${fmtBytes(payload.totalBytes)}）`);
          await refresh();
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
        } finally {
          setBusy('');
        }
      }, [password, includePlugins, includeWorkspaces, refresh]);

      const runFullBackup = React.useCallback(async () => {
        if (!window.confirm('确定要创建完整备份吗？\n\n完整备份将包含所有目录（包括 node_modules、dsh-runtimes、cache 等），体积可能达数 GB。\n\n适用于：卸载重装 DSH 后一键恢复场景。')) return;
        setBusy('fullbackup');
        setError('');
        setOk('');
        try {
          const fullBody = {};
          if (password) fullBody.password = password;
          if (includeWorkspaces) fullBody.includeWorkspaces = true;
          const payload = await request('/create-full', { method: 'POST', body: JSON.stringify(fullBody) });
          setOk(`完整备份完成：${payload.archive}（${payload.fileCount} 个文件，${fmtBytes(payload.totalBytes)}）\n${payload.note}`);
          await refresh();
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
        } finally {
          setBusy('');
        }
      }, [password, includeWorkspaces, refresh]);

      const runRestore = React.useCallback(
        async (archivePath, encrypted) => {
          // 加密备份必须在恢复时提供密码：先取密码输入框，没有再弹窗问一次。
          let secret = password;
          if (encrypted && !secret) {
            const typed = window.prompt(`这个备份是加密的，请输入备份时设置的密码：\n\n${archivePath}`);
            if (typed === null) return;
            if (!typed) {
              setError('已取消：加密备份必须输入备份时设置的密码');
              return;
            }
            secret = typed;
            setPassword(typed);
          }
          if (!window.confirm(`确定要恢复这个备份吗？\n\n${archivePath}\n\n恢复前会自动把当前配置快照到 .backup-snapshot。`)) return;
          setBusy('restore');
          setError('');
          setOk('');
          try {
            const payload = await request('/restore', {
              method: 'POST',
              body: JSON.stringify(secret ? { backupPath: archivePath, password: secret } : { backupPath: archivePath }),
            });
            if (payload && payload.ok === false) {
              throw new Error(payload.message || '恢复失败');
            }
            const base = `恢复完成：写入 ${payload.restored !== undefined ? payload.restored : '?'} 个文件。请重启 DSH 使配置生效。`;
            const rewrites = payload.pathRewrites
              ? `\n路径已改写：${payload.pathRewrites.from} → ${payload.pathRewrites.to}（${payload.pathRewrites.files} 个文件，${payload.pathRewrites.replacements} 处）`
              : '';
            const workspaceLine = Array.isArray(payload.workspaceRestores) && payload.workspaceRestores.length > 0
              ? `\n工作区已恢复：${payload.workspaceRestores.map((item) => `${item.name}（${item.files} 个文件 → ${item.to}）`).join('；')}`
              : '';
            const hints = Array.isArray(payload.hints) ? payload.hints : [];
            setOk(`${base}${rewrites}${workspaceLine}${hints.length > 0 ? `\n\n⚠️ ${hints.join('\n\n⚠️ ')}` : ''}`);
            await refresh();
          } catch (cause) {
            setError(cause && cause.message ? cause.message : String(cause));
          } finally {
            setBusy('');
          }
        },
        [password, refresh],
      );

      const checkUpdate = React.useCallback(async () => {
        setBusy('update');
        setError('');
        setOk('');
        try {
          const payload = await request('/update-check', { method: 'GET' });
          setUpdateInfo(payload);
          if (payload.isUpToDate) {
            setOk(`✅ 已是最新版本 ${payload.currentVersion}`);
          } else {
            setOk(`📦 发现新版本：${payload.currentVersion} → ${payload.latestVersion}\n查看更新：${payload.changelogUrl}`);
            setError('');
          }
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
          setOk('');
        } finally {
          setBusy('');
        }
      }, [refresh]);

      /* 一键备份并更新：先做一份普通备份，再从 npm 更新插件。
         顺序固定「先备份、后更新」，更新把插件换坏时用户手上一定有可恢复的备份。 */
      const runBackupAndUpdate = React.useCallback(async () => {
        const target = updateInfo && updateInfo.latestVersion ? updateInfo.latestVersion : '最新版本';
        const confirmed = window.confirm(
          `一键备份并更新？\n\n1) 先创建一份普通备份（一般备份，跳过 node_modules 等可重建目录）\n2) 再从 npm 更新到 ${target}\n\n备份完成后即使新版插件有问题，也能用这份备份恢复。继续？`,
        );
        if (!confirmed) return;
        setBusy('backup-update');
        setError('');
        setOk('');
        try {
          const payload = await request('/update', {
            method: 'POST',
            body: JSON.stringify(password ? { password } : {}),
          });
          const lines = [];
          if (payload.backupPath) lines.push(`备份：${payload.backupPath}`);
          if (payload.updated) {
            lines.push(`插件已更新：${payload.oldVersion} → ${payload.newVersion}`);
            lines.push('请重启 DSH 让新版本生效（重启前设置页仍显示旧版本是正常的）。');
          } else if (payload.latestVersion) {
            lines.push(`已是最新版本 ${payload.oldVersion}，未安装任何东西。`);
          } else {
            lines.push(payload.message || '更新未完成。');
          }
          if (Array.isArray(payload.log) && payload.log.length > 0 && !payload.ok) {
            lines.push('--- 日志 ---');
            lines.push(payload.log.slice(-12).join('\n'));
          }
          if (payload.ok) {
            setOk(lines.join('\n'));
            setError('');
            await refresh();
            void checkUpdate();
          } else {
            setError(lines.join('\n'));
            setOk('');
          }
        } catch (cause) {
          setError(cause && cause.message ? cause.message : String(cause));
          setOk('');
        } finally {
          setBusy('');
        }
      }, [password, refresh, checkUpdate, updateInfo]);

      /* 保存备份位置：可选把已有备份一起搬到新目录。 */
      const saveBackupDir = React.useCallback(
        async (target) => {
          const value = typeof target === 'string' ? target.trim() : '';
          setBusy('settings-dir');
          setError('');
          setOk('');
          try {
            const payload = await request('/settings', {
              method: 'POST',
              body: JSON.stringify({ backupDir: value ? value : null, migrate: migrateOnChange }),
            });
            const lines = [`备份位置已切换到：${payload.backupDir}`];
            if (payload.migration) {
              lines.push(payload.migration.message);
              if (!payload.migration.ok) lines.push('⚠️ 有项目没能搬过去，请检查旧目录里剩下的内容。');
            }
            setOk(lines.join('\n'));
            setDirDraft(null);
            await refresh();
          } catch (cause) {
            setError(cause && cause.message ? cause.message : String(cause));
          } finally {
            setBusy('');
          }
        },
        [migrateOnChange, refresh],
      );

      /* 保存自动备份设置：间隔 i 分钟、最多保留 j 份普通备份。 */
      const saveAutoBackup = React.useCallback(
        async (enabled, intervalMinutes, maxBackups) => {
          setBusy('settings-auto');
          setError('');
          setOk('');
          try {
            const payload = await request('/settings', {
              method: 'POST',
              body: JSON.stringify({
                autoBackup: {
                  enabled: enabled === true,
                  intervalMinutes: Number(intervalMinutes),
                  maxBackups: Number(maxBackups),
                },
              }),
            });
            const auto = payload.autoBackup;
            const lines = [];
            if (auto && auto.enabled) {
              lines.push(`自动备份已开启：每 ${auto.intervalMinutes} 分钟一次，保留最近 ${auto.maxBackups} 份普通备份。`);
              if (auto.nextRunAt) lines.push(`下次执行：${fmtTime(auto.nextRunAt)}`);
            } else {
              lines.push('自动备份已关闭。');
            }
            setOk(lines.join('\n'));
            setAutoEnabledDraft(null);
            setAutoIntervalDraft('');
            setAutoMaxDraft('');
            await refresh();
          } catch (cause) {
            setError(cause && cause.message ? cause.message : String(cause));
          } finally {
            setBusy('');
          }
        },
        [refresh],
      );

      const backups = state && Array.isArray(state.backups) ? state.backups : [];
      const settings = state && state.settings ? state.settings : null;
      const autoState = state && state.autoBackup ? state.autoBackup : null;
      const currentDir = state && state.backupDir ? state.backupDir : '';
      const dirValue = dirDraft === null ? currentDir : dirDraft;
      const autoEnabledValue = autoEnabledDraft === null ? (settings ? settings.autoBackup.enabled : false) : autoEnabledDraft;
      const autoIntervalValue =
        autoIntervalDraft === '' ? (settings ? String(settings.autoBackup.intervalMinutes) : '60') : autoIntervalDraft;
      const autoMaxValue = autoMaxDraft === '' ? (settings ? String(settings.autoBackup.maxBackups) : '10') : autoMaxDraft;

      return h(
        'div',
        { style: styles.root },
        h('h2', { style: styles.title }, '备份与恢复'),
        h(
          'p',
          { style: styles.hint },
          '把整个 DSH（设置、插件、技能、MCP、提示词、工作区等）打包成一个 zip，随时可以一键恢复。恢复对整机生效，执行前请先退出 DSH。',
        ),

        error ? h('div', { style: styles.bad }, error) : null,
        ok ? h('div', { style: styles.ok }, ok) : null,

        /* ---- 版本信息 & 更新检查 ---- */
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.row }, h('strong', { style: { fontSize: '13px' } }, '插件版本')),
          h(
            'div',
            { style: styles.kv },
            h('span', { style: styles.key }, '当前版本'),
            h('span', { style: styles.mono }, state && state.pluginVersion ? state.pluginVersion : '—'),
            h('span', { style: styles.key }, 'npm 最新版本'),
            h('span', { style: styles.mono }, updateInfo ? (updateInfo.latestVersion || '查询中…') : '—'),
          ),
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              { style: styles.button, disabled: busy !== '', onClick: checkUpdate },
              busy === 'update' ? '检查中…' : '🔍 检查更新',
            ),
            h(
              'button',
              { style: styles.primary, disabled: busy !== '', onClick: runBackupAndUpdate },
              busy === 'backup-update' ? '备份并更新中…' : '🔄 一键备份并更新',
            ),
            updateInfo && !updateInfo.isUpToDate
              ? h(
                  'span',
                  { style: { fontSize: '12px', color: '#d4a017', fontWeight: 500 } },
                  `新版本可用：${updateInfo.currentVersion} → ${updateInfo.latestVersion}`,
                )
              : null,
          ),
          h(
            'p',
            { style: styles.hint },
            '「一键备份并更新」= 先做一份普通备份，再从 npm 把插件升到最新版；更新把插件换坏时用这份备份恢复即可。已是最新版本时只备份、不安装。',
          ),
        ),

        /* ---- 普通备份 ---- */
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.kv },
            h('span', { style: styles.key }, 'DSH 目录'),
            h('span', { style: styles.mono }, state ? state.dshHome : '读取中…'),
            h('span', { style: styles.key }, '配置目录'),
            h('span', { style: styles.mono }, state ? state.profileDir : '读取中…'),
            h('span', { style: styles.key }, '备份根目录'),
            h('span', { style: styles.mono }, state ? state.backupDir : '读取中…'),
            h('span', { style: styles.key }, '一般备份目录'),
            h('span', { style: styles.mono }, state && state.backupDirs ? state.backupDirs.normal : '读取中…'),
            h('span', { style: styles.key }, '完整备份目录'),
            h('span', { style: styles.mono }, state && state.backupDirs ? state.backupDirs.full : '读取中…'),
            h('span', { style: styles.key }, 'DSH 状态'),
            h('span', null, state ? (state.dshRunning ? '运行中（可备份，不能整体恢复）' : '未运行') : '读取中…'),
          ),
          h(
            'div',
            { style: styles.row },
            h('input', {
              style: styles.input,
              type: 'password',
              placeholder: '可选：加密密码',
              value: password,
              onChange: (event) => setPassword(event.target.value),
            }),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: 0.85 } },
              h('input', {
                type: 'checkbox',
                checked: includePlugins,
                onChange: (event) => setIncludePlugins(event.target.checked),
              }),
              '包含插件文件（+几百 MB，换机器可直接用）',
            ),

            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: 0.85 } },
              h('input', {
                type: 'checkbox',
                checked: includeWorkspaces,
                onChange: (event) => setIncludeWorkspaces(event.target.checked),
              }),
              '连同工作区文件',
            ),
            h(
              'button',
              { style: styles.primary, disabled: busy !== '', onClick: runBackup },
              busy === 'backup' ? '备份中…' : '立即备份',
            ),
            h('button', { style: styles.button, disabled: busy !== '', onClick: refresh }, '刷新列表'),
          ),
          h('p', { style: styles.hint }, '填写密码会把整包加密（DSHBK002），恢复时必须输入同一个密码；同名 .bat 恢复时也会提示输入密码。'),
          h('p', { style: { ...styles.hint, fontSize: '11px', opacity: 0.55 } }, '⚡ 普通备份：跳过 node_modules、cache、logs 等可重建目录，体积小，适合日常备份。'),
          h(
            'p',
            { style: { ...styles.hint, fontSize: '11px', opacity: 0.7, color: '#c47f17' } },
            '⚠️ 默认的普通备份不含插件代码本身（node_modules）：恢复后 DSH 里会“有插件记录但加载不到插件”。可选两种做法：① 勾上上面的「包含插件文件」；② 恢复后在该 profile 目录执行 pnpm install --frozen-lockfile（package.json 与 pnpm-lock.yaml 在备份里）。想一份自带插件、离线可恢复的备份，用下面的「完整备份」。',
          ),
          h(
            'p',
            { style: { ...styles.hint, fontSize: '11px', opacity: 0.55 } },
            '📁 每份备份各占一个与压缩包同名的文件夹（内含 zip 和同名 .bat），一般备份与完整备份分别放在 normal/ 与 full/ 两个目录里。恢复时请双击该备份文件夹里同名的那份 .bat。',
          ),
        ),

        /* ---- 备份位置 ---- */
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.row }, h('strong', { style: { fontSize: '13px' } }, '📂 备份位置')),
          h('p', { style: styles.hint }, '备份默认放在 DSH 目录里；想放到别的盘（例如空间更大的 D 盘）就在这里改。'),
          h(
            'div',
            { style: styles.row },
            h('input', {
              style: { ...styles.input, minWidth: '360px' },
              type: 'text',
              placeholder: '例如 D:\\DSH-Backups（必须是绝对路径）',
              value: dirValue,
              onChange: (event) => setDirDraft(event.target.value),
            }),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: 0.85 } },
              h('input', {
                type: 'checkbox',
                checked: migrateOnChange,
                onChange: (event) => setMigrateOnChange(event.target.checked),
              }),
              '同时把已有备份迁移过去',
            ),
          ),
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              { style: styles.primary, disabled: busy !== '', onClick: () => saveBackupDir(dirValue) },
              busy === 'settings-dir' ? '保存中…' : '保存位置',
            ),
            h(
              'button',
              { style: styles.button, disabled: busy !== '', onClick: () => saveBackupDir('') },
              '恢复默认位置',
            ),
          ),
          h(
            'p',
            { style: { ...styles.hint, fontSize: '11px', opacity: 0.55 } },
            '迁移会把旧目录里的备份（含各自的同名文件夹与 .bat）整体搬到新目录，已有同名备份不会被覆盖；迁移后再做备份就落在新位置。',
          ),
        ),

        /* ---- 自动备份 ---- */
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.row }, h('strong', { style: { fontSize: '13px' } }, '⏱ 自动备份')),
          h(
            'p',
            { style: styles.hint },
            '开启后每隔 i 分钟自动做一次普通备份；普通备份超过 j 份时，自动删除最早的，只保留最近 j 份。全量备份永远不会被自动删除。',
          ),
          h(
            'div',
            { style: styles.row },
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
              h('input', {
                type: 'checkbox',
                checked: autoEnabledValue === true,
                onChange: (event) => setAutoEnabledDraft(event.target.checked),
              }),
              '启用自动备份',
            ),
            h('span', { style: { fontSize: '12px', opacity: 0.8 } }, '每隔'),
            h('input', {
              style: { ...styles.input, minWidth: '80px', width: '80px' },
              type: 'number',
              min: 1,
              value: autoIntervalValue,
              onChange: (event) => setAutoIntervalDraft(event.target.value),
            }),
            h('span', { style: { fontSize: '12px', opacity: 0.8 } }, '分钟备份一次，最多保留'),
            h('input', {
              style: { ...styles.input, minWidth: '80px', width: '80px' },
              type: 'number',
              min: 1,
              value: autoMaxValue,
              onChange: (event) => setAutoMaxDraft(event.target.value),
            }),
            h('span', { style: { fontSize: '12px', opacity: 0.8 } }, '份普通备份'),
            h(
              'button',
              { style: styles.primary, disabled: busy !== '', onClick: () => saveAutoBackup(autoEnabledValue, autoIntervalValue, autoMaxValue) },
              busy === 'settings-auto' ? '保存中…' : '保存自动备份设置',
            ),
          ),
          h(
            'div',
            { style: styles.kv },
            h('span', { style: styles.key }, '调度状态'),
            h(
              'span',
              null,
              autoState
                ? autoState.enabled
                  ? `已开启，每 ${autoState.intervalMinutes} 分钟`
                  : '未启用'
                : '读取中…',
            ),
            h('span', { style: styles.key }, '下次执行'),
            h('span', { style: styles.mono }, autoState && autoState.nextRunAt ? fmtTime(autoState.nextRunAt) : '—'),
            h('span', { style: styles.key }, '上次执行'),
            h(
              'span',
              { style: styles.mono },
              autoState && autoState.lastRunAt
                ? `${fmtTime(autoState.lastRunAt)}（${autoState.lastStatus === 'ok' ? '成功' : autoState.lastStatus === 'error' ? '失败' : '跳过'}）`
                : '—',
            ),
            h('span', { style: styles.key }, '上次结果'),
            h(
              'span',
              { style: styles.mono },
              autoState && autoState.lastError
                ? autoState.lastError
                : autoState && autoState.lastBackupPath
                  ? `${autoState.lastBackupPath}${autoState.lastPruned ? `（清理 ${autoState.lastPruned} 份旧备份）` : ''}`
                  : '—',
            ),
          ),
          h(
            'p',
            { style: { ...styles.hint, fontSize: '11px', opacity: 0.55 } },
            '自动备份在 DSH 进程里跑定时器：DSH 关闭期间不会备份，重新打开后按设置继续；修改设置立即生效，无需重启。',
          ),
        ),

        /* ---- 完整备份 ---- */
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.row }, h('strong', { style: { fontSize: '13px' } }, '📦 完整备份')),
          h('p', { style: styles.hint }, '包含所有目录（node_modules、dsh-runtimes、cache、web-login 等），体积可能达数 GB。'),
          h(
            'p',
            { style: { ...styles.hint, fontSize: '11px', opacity: 0.7, color: '#c47f17' } },
            '✅ 完整备份会把插件代码本身（profiles/*/node_modules）一起带走，恢复后不用联网重装插件——重装 DSH、换机器、离线恢复都用它。0.4.2 及更早版本的“完整备份”有 bug 实际没带 node_modules，请用 0.4.3 重新做一份。',
          ),
          h('p', { style: { ...styles.hint, fontSize: '11px', opacity: 0.55 } }, '🎯 适用场景：卸载重装 DSH 后一键恢复。恢复后无需重新安装任何依赖。'),
          h(
            'div',
            { style: styles.row },
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: 0.85 } },
              h('input', {
                type: 'checkbox',
                checked: includeWorkspaces,
                onChange: (event) => setIncludeWorkspaces(event.target.checked),
              }),
              '连同工作区文件',
            ),
            h(
              'button',
              { style: { ...styles.primary, background: '#8b5cf6' }, disabled: busy !== '', onClick: runFullBackup },
              busy === 'fullbackup' ? '完整备份中…' : '📦 创建完整备份',
            ),
          ),
        ),

        /* ---- 已有备份列表 ---- */
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.row }, h('strong', { style: { fontSize: '13px' } }, `已有备份（${backups.length}）`)),
          backups.length === 0
            ? h('p', { style: styles.hint }, '还没有备份，点上面的「立即备份」生成第一个。')
            : h(
                'table',
                { style: styles.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: styles.th }, '时间'),
                    h('th', { style: styles.th }, '类型'),
                    h('th', { style: styles.th }, '备份 / 对应恢复脚本'),
                    h('th', { style: styles.th }, '大小'),
                    h('th', { style: styles.th }, '操作'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  backups.map((item) =>
                    h(
                      'tr',
                      { key: item.path || item.name },
                      h('td', { style: styles.td }, fmtTime(item.createdAt)),
                      h('td', { style: styles.td }, item.kind === 'full' ? '完整' : '一般'),
                      h(
                        'td',
                        { style: styles.td },
                        h('span', { style: styles.mono }, item.name),
                        item.encrypted ? h('span', { style: { opacity: 0.6 } }, ' · 已加密') : null,
                        item.restoreBat
                          ? h(
                              'div',
                              { style: { ...styles.mono, opacity: 0.6, fontSize: '11px' } },
                              `↳ 双击恢复：${item.restoreBat.split(/[\\\\/]/).pop()}`,
                            )
                          : h('div', { style: { ...styles.mono, opacity: 0.5, fontSize: '11px' } }, '↳ 找不到同名 .bat，请用 restore.bat'),
                      ),
                      h('td', { style: styles.td }, fmtBytes(item.size)),
                      h(
                        'td',
                        { style: styles.td },
                        h(
                          'button',
                          {
                            style: styles.button,
                            disabled: busy !== '',
                            onClick: () => runRestore(item.path, item.encrypted),
                          },
                          busy === 'restore' ? '恢复中…' : '恢复',
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          h(
            'p',
            { style: styles.hint },
            '恢复必须用「对应版本」的脚本：每份备份都放在与压缩包同名的文件夹里，里面就有一份同名 .bat（例如 dsh-backup-20261022-101500.zip 对应 dsh-backup-20261022-101500.bat）。',
          ),
          h(
            'p',
            { style: styles.hint },
            'DSH 正在运行时无法整体恢复：请先退出 DSH，再双击该备份文件夹里同名的那份 .bat（Linux/macOS 用同名 .sh），它会在写入前自动快照当前配置。找不到同名脚本时才退而使用备份根目录的 restore.bat。',
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'backup-plugin',
              order: 60,
              label: '备份 Backup',
            },
            BackupSection,
          ),
        );
      },
    };
  },
});
