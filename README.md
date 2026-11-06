# DSH Backup Plugin

**English** | [简体中文](README.zh-CN.md)

Whole-`$DSH_HOME` backup and restore for DeepSeek Harness: one-click archive from the settings page, an agent-facing tool set, and a standalone restorer that runs without DSH.

## What gets backed up

Scope is the entire DSH home (default `~/.dsh`), not a single profile:

- `profiles/` — plugin install state, `package.json`, `cordis.patch.yml`, patch history
- `settings/`, `ui/`, `providers/`, `mcp/`, `prompts/`, `skills/`, `agentPresets/`, `agentInstructions/`
- `storages/`, `sessions/`, `workspaces/`, `.credentials.yaml`
- `dsh-config-manager/` (vault, rollback points, exports), `dsh-market/`

Skipped by default because they are large and rebuildable: `node_modules/`, `cache/`, `logs/`, `tmp/`, `locks/`, `running/`, `telemetry/`, `dsh-runtimes/`, `web-login/`, `speech-to-text/`, `attachments/`, plus any `*snapshot*`, `*.bak`, `*.old`, `*.trash` directory and `*.log` / `*.tmp` files. `node_modules/` skipping means a **normal** backup does *not* contain the plugin code itself — only the config plus a recorded plugin inventory (`name@version` per profile). A **full** backup includes `node_modules/` (and `dsh-runtimes/`, `cache/`, …) so it restores on a fresh machine without network access.

## Archive layout

Every archive contains `DSH-MANIFEST.json` at its root: format version, plugin version, source DSH home, per-file `sha256` and size, and the list of skipped entries. Restore verifies those hashes before writing anything.

With a password, the ZIP is encrypted as a whole rather than entry by entry: the file becomes `<name>.zip.enc`, so no filename or directory name leaks. Since 0.4.1 the wrapper is `DSHBK002`: PBKDF2-HMAC-SHA256 (200 000 iterations) derives both an AES-256-CBC key and an HMAC-SHA256 key, and the MAC covers `magic | salt | IV | ciphertext` (encrypt-then-MAC). The point of that choice is that the standalone `.bat` restorer can decrypt it with nothing but the PowerShell that ships with Windows — .NET Framework has no `AesGcm` and no scrypt. Archives made by 0.3.x–0.4.0 (`DSHBK001`, scrypt + AES-256-GCM) are still readable.

## Using it

Three entry points, same core:

**Settings page** — Settings → *备份 Backup*: take a backup now, refresh the list, restore a selected archive, pick where backups live, and schedule automatic backups. Restoring asks for confirmation and is rejected while DSH is running (`409 dsh-running`) because files would be overwritten under a live process. Restoring an encrypted archive asks for its password in a prompt (since 0.4.2); without it the request fails with `400 password-required`.

**Workspace files** — workspaces live outside `$DSH_HOME`, so they are opt-in: pass `includeWorkspaces: true` (或勾选设置页「连同工作区文件」). The plugin reads the paths registered in `storages/workspace.json`, packs each directory under `__workspaces__/<id>/…` in the same archive (recording `workspaceRoots` in the manifest), and on restore moves those files to the rewritten real paths, then removes the staging folder.

**Agent tools** — `backup_plugin_create`, `backup_plugin_create_full`, `backup_plugin_list`, `backup_plugin_restore`, `backup_plugin_status`, `backup_plugin_check_update`, `backup_plugin_update` (backup-then-update; pass `backup: false` to skip the backup), `backup_plugin_settings` (backupDir / migrate / autoEnabled / autoIntervalMinutes / autoMaxBackups), `backup_plugin_prune` (keep the newest N normal backups). Create accepts `password`, `backupDir`, `includeSessions`, `includeSecrets`, `includeAttachments`; restore accepts `backupPath`, `dryRun`, `password`.

**HTTP API** — `GET /api/dsh-backup-rescue/status`, `POST /api/dsh-backup-rescue/create`, `POST /api/dsh-backup-rescue/create-full`, `POST /api/dsh-backup-rescue/restore`, `GET /api/dsh-backup-rescue/update-check`, `POST /api/dsh-backup-rescue/update`, `GET|POST /api/dsh-backup-rescue/settings`, `POST /api/dsh-backup-rescue/prune` (loopback-only, like the rest of the settings API).

## Choosing where backups live

`📂 备份位置` on the settings page (tool `backup_plugin_settings`, `GET|POST /api/dsh-backup-rescue/settings`) accepts any **absolute** path (`~`, `%USERPROFILE%` and `$HOME` are expanded); saving an empty value falls back to `<DSH home>/dsh-backup-rescue/exports`. With *同时把已有备份迁移过去* checked, existing `normal/`, `full/` and legacy flat archives (together with their same-named `.bat`) are moved over, modification times preserved; collisions are merged under a renamed folder instead of overwritten. The move happens before the setting is stored — if the target directory cannot be created, the request fails and the old setting stays. Settings live in `<DSH home>/dsh-backup-rescue/settings.json`.

## Automatic backups

`⏱ 自动备份` runs a `normal` backup every `i` minutes (`1`–`43200`) and keeps at most `j` of them (`1`–`5000`): after each run the newest `j` normal backups stay and the older ones are deleted with their folders and same-named scripts. `full` backups are never pruned. The card shows the scheduler state, the next run time and the last result (including how many were pruned). Always restore with the `.bat` that ships inside that backup folder — it matches the plugin version that wrote it.

## Backup layout

Both kinds live under one root (`<DSH home>/dsh-backup-rescue/exports` by default, or whatever `backupDir` is set to) but in separate kind folders, and every backup gets its own folder named after the archive:

```
<root>/normal/dsh-backup-2026-10-22T10-15-00-000Z/
    dsh-backup-2026-10-22T10-15-00-000Z.zip        ← or .zip.enc with a password
    dsh-backup-2026-10-22T10-15-00-000Z.bat        ← double-click to restore this one
    dsh-backup-2026-10-22T10-15-00-000Z.sh
    restore.bat / restore.sh                       ← interactive fallback
<root>/full/dsh-backup-full-2026-10-22T10-20-00-000Z/
    …
```

A `normal` backup skips rebuildable directories (`node_modules/`, `cache/`, `logs/`, `dsh-runtimes/`, …); a `full` backup includes them. Deleting a backup folder deletes exactly that backup.

## Backup-then-update

**🔄 一键备份并更新** on the version card (tool `backup_plugin_update`, `POST /api/dsh-backup-rescue/update`) always runs in this order:

1. create a `normal` backup — if it fails, nothing else happens (no update without a backup)
2. ask npm for the latest version; if the local copy is not older, stop with only the backup made
3. add `dsh-backup-rescue@<new version>` to the profile's `minimumReleaseAgeExclude` so pnpm's 24h release-age rule does not reject a fresh release
4. install with the pnpm bundled in `dsh-runtimes/`, falling back to `npm install --save-exact`
5. verify the installed version; restart DSH to load it

## Standalone restorer

Restoring requires the script that ships with **that** backup — each backup folder contains a `.bat` / `.sh` named exactly like its archive:

- `<backup-name>.bat` / `.sh` — double-click to restore that exact archive (asks for the password when the archive is encrypted, shows the manifest, asks about the target, snapshots what it overwrites into `<target>/.backup-snapshot/bat-<rand>`)
- `restore.bat` / `restore.sh` — interactive: pick any archive, inspect it, choose the target

They need no DSH install and no Node.js: `.bat` uses only Windows PowerShell (and the DSH runtime `node.exe` for legacy `DSHBK001` archives), `.sh` uses `node` or `python3` (+ `openssl`, or `pycryptodome` for legacy archives) plus `unzip` or `python3`'s `zipfile`. `restore.bat` locates its archive through `%~dp0`, so a backup folder can be copied to another machine as a whole. Both refuse to run while `deepseek-harness` is alive.

Notes on the `.bat`: it is ASCII-only and CRLF on purpose. cmd.exe re-reads a batch file with the active code page, so a non-ASCII byte or a missing CR desyncs the parser — the symptom is a window that flashes open and closes. Automation can pass `DSH_RESTORE_PASSWORD`, `DSH_RESTORE_TARGET`, `DSH_RESTORE_YES=1`, `DSH_RESTORE_NO_PAUSE=1`, `DSH_RESTORE_SKIP_PROCESS_CHECK=1`.

Since 0.4.2 both restorers (and the in-DSH restore) clear the read-only flag before overwriting a file and put it back afterwards. DSH stores `attachments/v1/objects/**` as read-only checksum-addressed objects, so overwriting them used to fail with `UnauthorizedAccessException` / `EACCES` halfway through a restore.

## Update from npm

The plugin updates itself through the settings page, but the published package is a normal dependency:

```
npm install dsh-backup-rescue@latest --prefix ~/.dsh/profiles/<profile> --save-exact
```


## Install (local development)

```bash
pnpm install
pnpm build
```

Then install the directory through the plugin manager (it links the directory into the profile, so `lib/`, `client.js`, and `templates/` are read live):

```
plugin_manager install_bundle <path-to-this-directory>
```

The profile row must also be enabled in `cordis.patch.yml`; this bundle ships its own patch:

```yaml
- insert:
    - id: backup-plugin
      name: 'dsh-backup-rescue'
      config: {}
```

## Layout

- `src/backup.ts` — collection, manifest, ZIP, `DSHBK002` sealing (PBKDF2 + AES-256-CBC + HMAC), per-backup folders, restore-script emission
- `src/restore.ts` — verification, snapshotting, extraction
- `src/update.ts` — version lookup on npm, pnpm/npm install, backup-then-update orchestration
- `src/settings.ts` — persisted settings (`settings.json`): backup root, auto-backup interval/retention
- `src/migrate.ts` — move existing backups to a new root (mtimes kept, collisions merged)
- `src/prune.ts` — retention: keep the newest N normal backups, never touch full ones
- `src/scheduler.ts` — auto-backup timer (chained `setTimeout`, one tick at a time)
- `src/tools.ts` — hand-written tool definitions (external bundles cannot resolve `@deepseek-ai/dsh-tools`)
- `src/routes.ts` — settings-page HTTP routes
- `client.js` — settings section, loaded through `window.__ModuleLoader__`
- `templates/` — standalone restorers

## License

MIT
