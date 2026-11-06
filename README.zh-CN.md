# DSH 全量备份插件 v0.4.5

[English](README.md) | **简体中文**

给 DeepSeek Harness 做整机备份/恢复：设置页一键备份，agent 侧有工具，另附一个不依赖 DSH 的独立恢复器。

## 功能

- **全量备份**：备份整个 `$DSH_HOME`（settings、providers、plugins、skills、mcp、prompts、sessions、credentials 等）
- **一般 / 完整两种备份**：一般备份默认跳过 `node_modules`（插件代码本身）、`cache`、`logs` 等可重建目录，只带配置与插件清单；**勾选「包含插件文件」后一般备份也会打包 `profiles/*/node_modules`**；完整备份则把所有可重建目录（含 `dsh-runtimes`、`web-login`、`speech-to-text`）一起带走，离线可恢复
- **工作区文件可一起备份**：勾选「连同工作区文件」后，会从 `storages/workspace.json` 读出登记的工作区目录（默认在 `$DSH_HOME` 之外，比如 `Documents\deepseek-harness\default-workspace`），按 `__workspaces__/<id>/…` 收进同一个包；恢复时再按（已改写的）真实路径搬回去
- **恢复时自动改写路径**：换机器（用户名/盘符不同）时，把备份里记录的旧 `$DSH_HOME`、旧用户目录前缀自动替换成恢复目标的路径（覆盖 `storages/workspace.json` 等文本配置，跳过 `node_modules` 与 `.backup-snapshot`），`restore.bat` 与界面恢复都支持
- **备份位置可选**：设置页可以填任意绝对路径当备份根目录；换位置时可勾选“同时把已有备份迁移过去”，旧备份（含同名 `.bat`）连同修改时间一起搬走，搬完自动清空旧目录
- **定时自动备份**：填 `i` 分钟跑一次、`j` 份封顶；每次自动做一份**一般备份**，超过 `j` 份时自动删掉最早的（完整备份永不自动删除）
- **每份备份一个同名文件夹**：压缩包与它的同名 `.bat` / `.sh` 恢复脚本放在同一个以压缩包命名的文件夹里，多份备份互不覆盖
- **一键备份并更新**：先从 npm 查最新版 → 自动做一份一般备份 → 再升级插件；升级把插件换坏时，用刚做好的这份备份恢复即可
- **加密备份**：使用 DSHBK002（PBKDF2-SHA256 20 万次 + AES-256-CBC + HMAC-SHA256）加密整个 ZIP 包（`.zip.enc`），需密码恢复；恢复脚本用 Windows 自带 PowerShell 就能解开
- **SHA-256 校验**：清单文件记录每个文件的 SHA-256，恢复前全量校验
- **自动快照**：恢复前将被覆盖的文件备份到 `.backup-snapshot/<时间戳>/`
- **独立恢复器**：每份备份自带同名 `.bat` / `.sh`，不依赖 DSH 运行
- **插件清单**：一般备份在清单里记下每个 profile 装了什么插件（name@version），恢复后如果插件代码缺失会直接提示怎么重装
- **Agent 工具**：注册 `backup_plugin_create` / `create_full` / `restore` / `list` / `status` / `check_update` / `update` / `settings` / `prune` 九个工具

## 安装

插件已自动安装到 `~/.dsh/profiles/desktop/node_modules/dsh-backup-rescue/`。

重启 DSH 以加载插件。

## 使用

### Agent 工具

在 DSH 对话中可以直接使用以下工具：

- `backup_plugin_create` — 创建备份
  - 参数：`dshHome`（可选）、`backupDir`（可选）、`password`（可选，加密密码）、`includeSecrets`（可选）
  - 无需传参即可备份当前 DSH 安装

- `backup_plugin_list` — 列出备份文件

- `backup_plugin_restore` — 恢复备份
  - 参数：`backupPath`（必填）、`targetDir`（可选）、`password`（加密备份密码）、`dryRun`（预览）、`force`（跳过 DSH 运行检查）

- `backup_plugin_status` — 查看备份状态（含自动备份调度状态）

- `backup_plugin_settings` — 读写插件设置
  - 参数：`backupDir`（绝对路径，传空串表示恢复默认位置）、`migrate`（是否顺带迁移旧备份）、`autoEnabled`、`autoIntervalMinutes`（每隔 i 分钟）、`autoMaxBackups`（最多保留 j 份）

- `backup_plugin_prune` — 只按保留份数清理普通备份
  - 参数：`maxBackups`（默认取设置里的 j）、`backupDir`（可选）

### 备份位置

设置页「📂 备份位置」卡片（或工具 `backup_plugin_settings`、HTTP `GET/POST /api/dsh-backup-rescue/settings`）：

- 填任意**绝对路径**（支持 `~`、`%USERPROFILE%`），保存后新的备份都落在那里；留空保存即恢复默认位置 `<DSH_HOME>/dsh-backup-rescue/exports`
- 勾选「同时把已有备份迁移过去」后，旧目录里的 `normal/`、`full/`、历史平铺备份（含同名 `.bat`）会整体搬到新位置，并保留修改时间；目标已存在同名备份时不会覆盖，会改名合并
- 迁移只在保存成功前发生：目标目录建不出来就报错并保留原设置
- 设置存放在 `<DSH_HOME>/dsh-backup-rescue/settings.json`

### 自动备份

设置页「⏱ 自动备份」卡片：

- 勾选启用后，按填的数字 **每隔 i 分钟**自动做一份**一般备份**（`i` 取 1–43200）
- **最多保留 j 份**（`j` 取 1–5000）：每次自动备份后按时间倒序只留最新的 j 份普通备份，更早的连同它们的文件夹、同名 `.bat` 一起删掉
- 完整备份不参与淘汰，永远不会被自动删除
- 卡片里能看到调度状态、下次执行时间、上次执行结果与上次清理了几份
- 卡片提示「恢复时请运行对应版本的 .bat」：备份文件夹里的 `<备份名>.bat` 与你当前插件版本配套，别混用别的版本留下的脚本

### 备份目录布局

```
<backupDir>/                        默认 ~/.dsh/dsh-backup-rescue/exports
├── normal/
│   └── dsh-backup-2026-10-22T10-15-00-000Z/     ← 与压缩包同名的文件夹
│       ├── dsh-backup-2026-10-22T10-15-00-000Z.zip
│       ├── dsh-backup-2026-10-22T10-15-00-000Z.bat   ← 双击恢复这份备份
│       ├── dsh-backup-2026-10-22T10-15-00-000Z.sh    ← macOS/Linux 同一份
│       ├── restore.bat
│       └── restore.sh
└── full/
    └── dsh-backup-full-2026-10-22T10-20-00-000Z/
        ├── dsh-backup-full-2026-10-22T10-20-00-000Z.zip
        └── …（同上）
```

一般备份与完整备份分开存放；每份备份的压缩包和它的恢复脚本在同一个文件夹里，不会互相覆盖，删掉一个文件夹就等于删掉这一份备份。

### 一键备份并更新

设置页「版本」卡片上的 **🔄 一键备份并更新**（Agent 工具 `backup_plugin_update`，HTTP `POST /api/dsh-backup-rescue/update`）固定按这个顺序执行：

1. 先做一份**一般备份**（失败就立即终止，不会在没有备份的情况下动插件）
2. 查 npm 上的最新版本；本地不比它旧就直接结束，只留备份
3. 把 `dsh-backup-rescue@<新版本>` 加进 profile `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（否则 24 小时内发布的新版会被 pnpm 拒绝）
4. 优先用 DSH 自带的 pnpm 安装（`dsh-runtimes/*/dependencies/pnpm`），失败退回 `npm install --save-exact`
5. 校验安装后的版本号，重启 DSH 生效

### 独立恢复器

恢复**必须用对应版本的脚本**：每份备份的文件夹里都有一份与压缩包同名的 `.bat`（加密备份对应 `.bat` 里带 `--password` 提示），双击它就会恢复这一份备份：

- `<备份名>.bat` / `<备份名>.sh` — 双击即恢复该备份；加密备份会先提示输入密码
- `restore.bat` / `restore.sh` — 交互式：手动挑任意备份、查看清单、选择目标目录

**注意（0.4.1 起）**：`restore.bat` 是**纯 ASCII + CRLF**，既不带 BOM 也不含中文。原先是 UTF-8 BOM + 中文注释，cmd.exe 会按当前代码页重新读文件，多字节字符把解析器带到行中间，双击就变成“窗口一闪而过”（还会报 `'OT' is not recognized`）。所以脚本内所有提示改成了英文，中文说明放在设置页与本文档里。

加密备份（`.zip.enc`）的解密环境：
- `DSHBK002`（0.4.1 起）：Windows 用自带 PowerShell 5.1；macOS/Linux 用 `node`，没有 node 时用 `python3 + openssl`
- `DSHBK001`（0.3.x–0.4.0）：需要 DSH 自带 `node.exe`（Windows）或 `pycryptodome`（macOS/Linux），否则脚本会提示改用 DSH 界面恢复

把某个备份文件夹整体挪到别的机器上，双击里面的同名 `.bat` 也能恢复（脚本用 `%~dp0` 定位同目录的压缩包）。自动化可用环境变量：`DSH_RESTORE_PASSWORD`（密码含引号/空格/& 时只有这种方式可靠）、`DSH_RESTORE_TARGET`、`DSH_RESTORE_YES=1`、`DSH_RESTORE_NO_PAUSE=1`、`DSH_RESTORE_SKIP_PROCESS_CHECK=1`。

**注意（0.4.2 起）**：覆盖文件前会先清掉只读属性、写完再还原。DSH 把 `attachments/v1/objects/**` 存成只读的校验和对象，以前恢复会在这类文件上抛 `ExtractToFile` 的“访问被拒绝”，整次恢复中断。另外在设置页点「恢复」加密备份时会先弹窗要密码，没给就返回 `400 password-required`，不会再静默失败。

## 文件结构

```
dsh-backup-rescue/
├── src/
│   ├── index.ts       # 插件入口（同时启动自动备份调度器）
│   ├── types.ts       # 共享类型定义
│   ├── backup.ts      # 备份核心
│   ├── restore.ts     # 恢复核心
│   ├── update.ts      # 一键备份并更新（npm 查询 + pnpm/npm 安装）
│   ├── settings.ts    # 设置持久化（备份位置 / 自动备份）
│   ├── migrate.ts     # 换备份位置时的迁移
│   ├── prune.ts       # 保留份数 + 删除最早的普通备份
│   ├── scheduler.ts   # 自动备份调度器（setTimeout 链）
│   ├── tools.ts       # Agent 工具注册
│   └── routes.ts      # REST API 路由
├── templates/
│   ├── restore.bat    # Windows 独立恢复器（纯 ASCII + CRLF，不带 BOM）
│   └── restore.sh     # macOS/Linux 独立恢复器
├── tests/
│   ├── backup.test.ts          # 备份/恢复/加密/插件清单单测（34 条）
│   ├── update.test.mjs         # 一键备份并更新单测（15 条）
│   ├── settings.test.mjs       # 设置/迁移/清理/调度单测（38 条）
│   └── client-render.test.mjs  # 设置页组件渲染冒烟
├── cordis.patch.yml   # Cordis 插件加载配置
└── package.json
```

## 跳过规则

默认跳过：
- `node_modules`、`.git`、`.cache`、`cache`、`logs`、`log`、`tmp`、`temp`
- `dsh-runtimes`、`web-login`、`speech-to-text`、`dsh-market`（顶层）
- 目录名含 `snapshot`、`.bak`、`.old`、`.trash` 的目录
- 后缀为 `.log`、`.tmp` 的文件

## 加密

加密备份格式（0.4.1 起）：
```
[DSHBK002][16-byte salt][16-byte IV][32-byte HMAC][AES-256-CBC 密文]
```

- 密钥：PBKDF2-HMAC-SHA256（20 万次）从密码派生 64 字节，前 32 字节做 AES-256-CBC 密钥，后 32 字节做 HMAC-SHA256 密钥
- 认证：HMAC 覆盖 `magic | salt | IV | 密文`（encrypt-then-MAC），密码错误报 `wrong password (HMAC mismatch)`
- 为什么不用 GCM：独立恢复脚本只能用 Windows 自带的 PowerShell 5.1，它既没有 `AesGcm` 也没有 scrypt，而 PBKDF2 / AES-CBC / HMAC 全都有
- 旧格式 `DSHBK001`（`[DSHBK001][salt][IV][tag][AES-256-GCM 密文]`，scrypt 派生密钥）仍可解密
- 密码至少 4 个字符

## 测试

```bash
npm run build
node --test tests/backup.test.ts     # 47 条：备份/恢复/加密/排除规则/只读覆盖/插件清单/可选带插件/路径改写
node tests/update.test.mjs           # 15 条：版本比较、registry 查询、白名单、一键备份并更新
node tests/settings.test.mjs         # 38 条：设置读写、位置迁移、保留策略、定时调度
node tests/restore-bat.test.mjs      # 32 条：真实调用 cmd.exe 跑 .bat（双击路径、特殊密码、错误密码、只读目标、路径改写、工作区恢复、旧格式）
node tests/client-render.test.mjs ./client.js   # 设置页组件渲染冒烟
```

## 版本历史

- **0.4.5** — 备份可包含工作区文件：新增 `includeWorkspaces`（设置页「连同工作区文件」复选框、工具参数同名），从 `storages/workspace.json` 读取工作区路径并逐文件打包到 `__workspaces__/<id>/…`（清单记录 `workspaceRoots`、`includedWorkspaces`；工作区里同样跳过 `node_modules`/`cache`/`*.log` 等）；恢复时先按路径改写算出新位置，再把暂存文件搬到真实目录并清空暂存（`.bat` 与界面恢复都支持，结果里多出 `workspaceRestores`）。踩坑：`.bat` 里用 `FullName.Substring(stage.Length)` 求相对路径时，`%TEMP%` 的 8.3 短路径（`XIAOXI~1`）与 .NET 返回的长路径长度不一致，导致文件被塞进 `-6\` 这类错目录；改成按名字递归搬运后修复

- **0.4.4** — 一般备份新增「包含插件文件」选项（勾上后 `includeNodeModules: true`，把 `profiles/*/node_modules` 打进包，体积约 +455 MB，换机器/离线可直接用）；恢复默认自动改写绝对路径：把备份清单里的旧 `$DSH_HOME`、旧用户目录前缀替换为恢复目标（同时匹配 `\`、JSON 转义的 `\\` 与 `/` 三种写法，跳过 `node_modules` 与 `.backup-snapshot`，单文件 ≤8 MB），`restore.bat`（脚本内报告 `[OK] path rewrite: N file(s)`）与界面/工具恢复（`rewritePaths`，结果里带 `pathRewrites` 统计）都支持，可用 `rewritePaths: false` 关闭
- **0.4.3** — 修复“完整备份其实没带插件”：`node_modules` 一直被无条件跳过，导致全量备份也缺插件代码，恢复后 DSH 有插件记录却加载不到；现在全量备份会打包 `profiles/*/node_modules` 等目录（只永久跳过 `exports`/`.git`/临时目录）；一般备份在清单里新增 `plugins`（各 profile 的 name@version）与 `includedNodeModules` 标记，恢复后若 profile 有依赖清单却没有 `node_modules` 会明确提示 `pnpm install --frozen-lockfile`；设置页对两种备份的差异加了醒目提示
- **0.4.2** — 修复恢复被只读文件打断：DSH 的 `attachments/v1/objects/**` 是只读对象，`.bat` 的 `ExtractToFile` 与界面恢复的 `writeFileSync` 都会抛“访问被拒绝/EACCES”，现在覆盖前清只读、写完还原（`restore.bat` 与 `src/restore.ts` 同一策略，新增 4 条只读覆盖断言）；设置页恢复加密备份时会弹窗要密码，缺失时后端返回 `400 password-required`，界面不再把 `ok:false` 当成功显示
- **0.4.1** — 修复「加密备份双击同名 `.bat` 只闪一下就关」：根因是 `restore.bat` 以 LF 保存、且用 UTF-8 BOM + 中文（cmd 按当前代码页重读文件会把解析器带到行中间）；改为**纯 ASCII + CRLF、无 BOM**；加密封装升级为 `DSHBK002`（PBKDF2-SHA256 20 万次 + AES-256-CBC + HMAC-SHA256），让恢复脚本只靠 Windows 自带 PowerShell 就能解密，旧 `DSHBK001` 仍可读；`restore.sh` 支持两种封装并优先用 node、没有 node 时用 `python3 + openssl`（解压也支持退回 python3 的 `zipfile`）；新增 `tests/restore-bat.test.mjs`（真实调用 `cmd.exe` 走双击路径、特殊密码、错误密码、旧格式）
- **0.4.0** — 备份位置可选（任意绝对路径，可连同已有备份一起迁移，保留修改时间、冲突不覆盖）；新增定时自动备份（每隔 i 分钟做一份一般备份，最多保留 j 份，超过自动删最早的，完整备份不参与）；新增 `settings.json` 持久化、`backup_plugin_settings` / `backup_plugin_prune` 工具与 `GET/POST /settings`、`POST /prune` 路由；设置页新增「备份位置」「自动备份」两张卡片
- **0.3.3** — 「一键更新」改为「一键备份并更新」（先做一般备份再从 npm 升级，备份失败即中止）；每份备份改为独立同名文件夹，压缩包与同名 `.bat`/`.sh` 放在一起；一般备份与完整备份分别落在 `exports/normal/`、`exports/full/`；设置页显示三个备份目录、备份列表带类型列并提供「对应恢复脚本」提示；`listBackups` 兼容 0.3.2 的平铺目录
- **0.3.2** — 新增全量备份（包含 node_modules 等所有目录）、一键更新检查/安装；包名从 `dsh-backup-plugin` 改为 `dsh-backup-rescue`
- **0.3.1** — 新增 types.ts 共享类型；修复 restore.bat UTF-8 BOM；测试全面更新；独立恢复器支持加密备份
- **0.3.0** — 完整备份/恢复，SHA-256 校验，AES-256-GCM 加密，Agent 工具注册

## 许可证

MIT
