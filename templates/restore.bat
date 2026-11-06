@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem =====================================================================
rem  restore.bat - standalone restorer for dsh-backup-rescue archives
rem
rem  Usage: double-click this file, or
rem         restore.bat "D:\path\to\dsh-backup-xxx.zip"
rem         restore.bat "D:\path\to\dsh-backup-xxx.zip.enc" "password"
rem
rem  Supported encryption wrappers:
rem    DSHBK002 (0.4.1+)  PBKDF2-SHA256 + AES-256-CBC + HMAC-SHA256.
rem                       Decrypted with the PowerShell that ships with
rem                       Windows; no extra component is required.
rem    DSHBK001 (0.3.x-0.4.0) scrypt + AES-256-GCM. Needs the node.exe that
rem                       ships with the DeepSeek Harness runtime.
rem
rem  Batch files are kept ASCII-only on purpose: a non-ASCII byte stream in a
rem  .bat is re-read by cmd.exe with the active code page and can desync the
rem  parser (the classic "window flashes and closes" symptom).
rem
rem  Environment variables for automation / tests (not needed when clicking):
rem    DSH_RESTORE_NO_PAUSE=1            do not wait for a key press at the end
rem    DSH_RESTORE_SKIP_PROCESS_CHECK=1  skip the "DSH is running" check
rem    DSH_RESTORE_TARGET=<dir>          restore target, skip the prompt
rem    DSH_RESTORE_YES=1                 skip the confirmation prompt
rem    DSH_RESTORE_PASSWORD=<password>   use this password; safe for values
rem                                      with quotes/spaces/& because it does
rem                                      not go through cmd argument parsing
rem =====================================================================

set "DO_PAUSE=pause"
if defined DSH_RESTORE_NO_PAUSE set "DO_PAUSE="

echo ========================================
echo    DSH backup restorer  v0.4.1
echo ========================================
echo.

rem --- 1. DSH must be stopped -------------------------------------------
if defined DSH_RESTORE_SKIP_PROCESS_CHECK goto :process_ok
tasklist /FI "IMAGENAME eq deepseek-harness.exe" /NH 2>nul | find /I "deepseek-harness.exe" >nul
if not errorlevel 1 goto :dsh_running
:process_ok
echo [OK] DeepSeek Harness is not running.
echo.

rem --- 2. Pick the archive ----------------------------------------------
set "BACKUP_PATH=%~1"
if not "%BACKUP_PATH%"=="" goto :have_path
set /p BACKUP_PATH=Drag the backup zip here, or type its full path: 
:have_path
set "BACKUP_PATH=%BACKUP_PATH:"=%"
if exist "%BACKUP_PATH%" goto :path_ok
echo [ERROR] File not found: %BACKUP_PATH%
%DO_PAUSE%
exit /b 1
:path_ok
echo [OK] Archive: %BACKUP_PATH%
echo.

set "DSH_ARCHIVE=%BACKUP_PATH%"
rem Password sources, highest priority first:
rem   1) DSH_RESTORE_PASSWORD (verbatim, bypasses cmd quoting)
rem   2) second command line argument
rem   3) interactive prompt
set "DSH_PASSWORD="
if defined DSH_RESTORE_PASSWORD set "DSH_PASSWORD=!DSH_RESTORE_PASSWORD!"
if not defined DSH_PASSWORD if not "%~2"=="" set "DSH_PASSWORD=%~2"
set "IS_ENC="
if /I "%BACKUP_PATH:~-4%"==".enc" set "IS_ENC=1"

rem --- 3. Decrypt when the archive is encrypted -------------------------
set "WORKING_FILE=%BACKUP_PATH%"
set "TEMP_DIR=%TEMP%\dsh-restore-%RANDOM%%RANDOM%"
if not defined IS_ENC goto :decrypt_done
mkdir "%TEMP_DIR%" 2>nul
set "DSH_OUT=%TEMP_DIR%\backup.zip"

rem Read the first 8 bytes to learn which wrapper was used.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$fs=[IO.File]::OpenRead($env:DSH_ARCHIVE); $buf=New-Object byte[] 8; $fs.Read($buf,0,8) | Out-Null; $fs.Close(); [Text.Encoding]::ASCII.GetString($buf)" > "%TEMP_DIR%\magic.txt" 2>nul
set "MAGIC="
set /p MAGIC=<"%TEMP_DIR%\magic.txt"

if not defined DSH_PASSWORD set /p DSH_PASSWORD=Backup password: 
rem Never test the password with if "%DSH_PASSWORD%"==... : a quote, &, | or < >
rem inside the password would split the command line at parse time.
if not defined DSH_PASSWORD goto :no_password

echo [INFO] Decrypting (format !MAGIC!)...
if /I "!MAGIC!"=="DSHBK002" goto :decrypt_v2
if /I "!MAGIC!"=="DSHBK001" goto :decrypt_v1
echo [ERROR] Not a dsh-backup-rescue encrypted archive (header: !MAGIC!).
%DO_PAUSE%
exit /b 1

:decrypt_v2
rem PBKDF2-HMAC-SHA256(200000) + AES-256-CBC + HMAC-SHA256: all of it is
rem built into .NET Framework, so plain Windows PowerShell can do it.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $raw=[IO.File]::ReadAllBytes($env:DSH_ARCHIVE); if($raw.Length -lt 73){ throw 'archive too short' }; $salt=New-Object byte[] 16; [Array]::Copy($raw,8,$salt,0,16); $iv=New-Object byte[] 16; [Array]::Copy($raw,24,$iv,0,16); $mac=New-Object byte[] 32; [Array]::Copy($raw,40,$mac,0,32); $clen=$raw.Length-72; $ct=New-Object byte[] $clen; [Array]::Copy($raw,72,$ct,0,$clen); $kdf=New-Object Security.Cryptography.Rfc2898DeriveBytes($env:DSH_PASSWORD,$salt,200000,[Security.Cryptography.HashAlgorithmName]::SHA256); $all=$kdf.GetBytes(64); $key=New-Object byte[] 32; [Array]::Copy($all,0,$key,0,32); $mk=New-Object byte[] 32; [Array]::Copy($all,32,$mk,0,32); $h=[Security.Cryptography.HMACSHA256]::new($mk); $head=New-Object byte[] 40; [Array]::Copy($raw,0,$head,0,40); $hm=$h.ComputeHash([byte[]]($head+$ct)); if([Convert]::ToBase64String($hm) -ne [Convert]::ToBase64String($mac)){ throw 'wrong password' }; $aes=[Security.Cryptography.Aes]::Create(); $aes.Mode=[Security.Cryptography.CipherMode]::CBC; $aes.Padding=[Security.Cryptography.PaddingMode]::PKCS7; $aes.Key=$key; $aes.IV=$iv; $dec=$aes.CreateDecryptor(); $plain=$dec.TransformFinalBlock($ct,0,$clen); [IO.File]::WriteAllBytes($env:DSH_OUT,$plain); Write-Host '[OK] decrypted'"
if errorlevel 1 goto :decrypt_fail
goto :decrypt_ok

:decrypt_v1
rem Legacy wrapper: scrypt + AES-256-GCM. Windows PowerShell cannot do this,
rem so borrow the node.exe and the installed plugin that ship with DSH.
set "NODE_EXE="
for %%N in ("%USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe") do if not defined NODE_EXE if exist "%%~fN" set "NODE_EXE=%%~fN"
set "PLUGIN_LIB="
for %%L in ("%USERPROFILE%\.dsh\profiles\*\node_modules\dsh-backup-rescue\lib\backup.js") do if not defined PLUGIN_LIB if exist "%%~fL" set "PLUGIN_LIB=%%~fL"
if not defined NODE_EXE goto :v1_no_node
if not defined PLUGIN_LIB goto :v1_no_node
set "DSH_LIB=%PLUGIN_LIB%"
echo [INFO] Legacy format DSHBK001: decrypting with the node.exe shipped by DSH...
"%NODE_EXE%" --input-type=module -e "import{readFileSync as rf,writeFileSync as wf}from'node:fs';const m=await import('file:///'+process.env.DSH_LIB.replace(/\\/g,'/'));wf(process.env.DSH_OUT,m.decryptArchive(rf(process.env.DSH_ARCHIVE),process.env.DSH_PASSWORD));console.log('[OK] decrypted');"
if errorlevel 1 goto :decrypt_fail
goto :decrypt_ok

:v1_no_node
echo [ERROR] This encrypted backup uses the legacy DSHBK001 format
echo         (created by plugin 0.3.x - 0.4.0).
echo         That format needs scrypt + AES-256-GCM, which the PowerShell
echo         bundled with Windows does not provide, and the node.exe of the
echo         DeepSeek Harness runtime was not found here:
echo           %USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe
echo         Use one of these instead:
echo           1) start DSH, open Settings - Backup, and restore with the
echo              password there;
echo           2) create a new encrypted backup with plugin 0.4.1 or newer
echo              (the new DSHBK002 format restores on its own).
%DO_PAUSE%
exit /b 1

:no_password
echo [ERROR] No password entered, cannot decrypt.
%DO_PAUSE%
exit /b 1

:decrypt_fail
echo [ERROR] Decryption failed: wrong password, or the file is damaged.
%DO_PAUSE%
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%" 2>nul
exit /b 1

:decrypt_ok
set "WORKING_FILE=%TEMP_DIR%\backup.zip"
echo [OK] Decryption finished.
echo.

:decrypt_done
rem --- 4. Show the manifest --------------------------------------------
set "DSH_ZIP=%WORKING_FILE%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:DSH_ZIP); $e=$z.GetEntry('DSH-MANIFEST.json'); if(-not $e){ $z.Dispose(); exit 2 }; $r=New-Object IO.StreamReader($e.Open()); $m=$r.ReadToEnd() | ConvertFrom-Json; $r.Close(); $z.Dispose(); Write-Host ('  created  : ' + $m.createdAt); Write-Host ('  source   : ' + $m.dshHome); Write-Host ('  files    : ' + $m.fileCount); Write-Host ('  size     : ' + [math]::Round($m.totalBytes/1MB,2) + ' MB'); Write-Host ('  password : ' + $m.encrypted)"
if errorlevel 2 goto :not_our_backup
echo.

rem --- 5. Choose the target directory ----------------------------------
set "DEFAULT_TARGET=%USERPROFILE%\.dsh"
set "TARGET_DIR=%DSH_RESTORE_TARGET%"
if not defined TARGET_DIR set /p TARGET_DIR=Restore into which directory? Enter = %DEFAULT_TARGET% : 
if not defined TARGET_DIR set "TARGET_DIR=%DEFAULT_TARGET%"
echo [OK] Target: %TARGET_DIR%
echo.

echo Files with the same name in the target are overwritten (nothing is
echo deleted). A snapshot of the overwritten files is kept under
echo %TARGET_DIR%\.backup-snapshot
set "CONFIRM="
if "%DSH_RESTORE_YES%"=="1" set "CONFIRM=Y"
if not defined CONFIRM set /p CONFIRM=Continue? (Y/N): 
if /i not "%CONFIRM%"=="Y" goto :cancelled

rem --- 6. Snapshot + extract -------------------------------------------
echo.
echo [INFO] Extracting (existing files are snapshotted first)...
set "DSH_DEST=%TARGET_DIR%"
set "DSH_SNAP=%TARGET_DIR%\.backup-snapshot\bat-%RANDOM%%RANDOM%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:DSH_ZIP); $dest=$env:DSH_DEST; $snap=$env:DSH_SNAP; $n=0; $s=0; foreach($e in $z.Entries){ if($e.FullName -eq 'DSH-MANIFEST.json'){ continue }; $rel=$e.FullName -replace '/','\'; $full=Join-Path $dest $rel; $dir=[IO.Path]::GetDirectoryName($full); if($dir -and -not (Test-Path $dir)){ New-Item -ItemType Directory -Path $dir -Force | Out-Null }; $attr=$null; if(Test-Path -LiteralPath $full){ $item=Get-Item -LiteralPath $full -Force; $attr=$item.Attributes; $sdir=Join-Path $snap $rel; $sdirp=[IO.Path]::GetDirectoryName($sdir); if($sdirp -and -not (Test-Path $sdirp)){ New-Item -ItemType Directory -Path $sdirp -Force | Out-Null }; Copy-Item -LiteralPath $full -Destination $sdir -Force; if($item.IsReadOnly){ $item.IsReadOnly=$false }; $s=$s+1 }; [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$full,$true); if($attr -ne $null){ [IO.File]::SetAttributes($full,$attr) }; $n=$n+1 }; $z.Dispose(); Write-Host ('[OK] wrote ' + $n + ' files, snapshotted ' + $s + ' overwritten files into ' + $snap)"
if errorlevel 1 goto :extract_fail

rem --- 6b. Rewrite absolute paths: old DSH home / old user name -> restore target ---
rem When the user name or drive differs, absolute paths inside the backup
rem (storages/workspace.json and friends) must be pointed at the new location.
echo [INFO] Rewriting absolute paths recorded in the backup...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:DSH_ZIP); $e=$z.GetEntry('DSH-MANIFEST.json'); $r=New-Object IO.StreamReader($e.Open()); $m=$r.ReadToEnd() | ConvertFrom-Json; $r.Close(); $z.Dispose(); $old=([string]$m.dshHome).TrimEnd('\'); $new=([string]$env:DSH_DEST).TrimEnd('\'); if((-not $old) -or ($old -ieq $new)){ Write-Host '[INFO] path rewrite skipped (same home, or manifest has no dshHome)'; exit 0 }; $oldRoot=Split-Path $old -Parent; $newRoot=Split-Path $new -Parent; $exts=@('.json','.jsonl','.yaml','.yml','.md','.txt','.js','.mjs','.cjs','.ts','.bat','.sh','.ps1','.cfg','.ini','.toml','.xml','.csv','.conf','.properties'); $files=Get-ChildItem -LiteralPath $new -Recurse -File -Force | Where-Object { $exts -contains $_.Extension.ToLowerInvariant() -and $_.Length -lt 8388608 -and $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.backup-snapshot\\' }; $changed=0; foreach($f in $files){ $bytes=[IO.File]::ReadAllBytes($f.FullName); $hasBom=($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191); $text=[Text.Encoding]::UTF8.GetString($bytes); $before=$text; foreach($pair in @(@($old,$new),@($oldRoot,$newRoot))){ $from=[string]$pair[0]; $to=[string]$pair[1]; if((-not $from) -or ($from -ieq $to)){ continue }; $text=[regex]::Replace($text,[regex]::Escape($from),{ param($mm) $to },[Text.RegularExpressions.RegexOptions]::IgnoreCase); $text=[regex]::Replace($text,[regex]::Escape($from.Replace('\','\\')),{ param($mm1) $to.Replace('\','\\') },[Text.RegularExpressions.RegexOptions]::IgnoreCase); $fromSlash=$from.Replace('\','/'); $toSlash=$to.Replace('\','/'); $text=[regex]::Replace($text,[regex]::Escape($fromSlash),{ param($mm2) $toSlash },[Text.RegularExpressions.RegexOptions]::IgnoreCase) }; if($text -ne $before){ $item=Get-Item -LiteralPath $f.FullName -Force; $wasReadOnly=$item.IsReadOnly; if($wasReadOnly){ $item.IsReadOnly=$false }; [IO.File]::WriteAllText($f.FullName,$text,(New-Object Text.UTF8Encoding($hasBom))); if($wasReadOnly){ [IO.File]::SetAttributes($f.FullName,[IO.FileAttributes]::ReadOnly) }; $changed=$changed+1 } }; Write-Host ('[OK] path rewrite: ' + $changed + ' file(s), ' + $old + ' -> ' + $new)"

rem --- 6c. Move packed workspace files to their real (rewritten) locations ---
echo [INFO] Restoring workspace files...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:DSH_ZIP); $e=$z.GetEntry('DSH-MANIFEST.json'); $r=New-Object IO.StreamReader($e.Open()); $m=$r.ReadToEnd() | ConvertFrom-Json; $r.Close(); $z.Dispose(); $roots=@($m.workspaceRoots); if($roots.Count -eq 0){ Write-Host '[INFO] no workspace files in this backup'; exit 0 }; $old=([string]$m.dshHome).TrimEnd('\'); $new=([string]$env:DSH_DEST).TrimEnd('\'); $oldRoot=Split-Path $old -Parent; $newRoot=Split-Path $new -Parent; function RewritePath([string]$value){ $x=$value; foreach($pair in @(@($old,$new),@($oldRoot,$newRoot))){ $from=[string]$pair[0]; $to=[string]$pair[1]; if((-not $from) -or ($from -ieq $to)){ continue }; $x=[regex]::Replace($x,[regex]::Escape($from),{ param($mm) $to },[Text.RegularExpressions.RegexOptions]::IgnoreCase); $x=[regex]::Replace($x,[regex]::Escape($from.Replace('\','/')),{ param($mm2) $to.Replace('\','/') },[Text.RegularExpressions.RegexOptions]::IgnoreCase) }; return $x }; $total=0; function MoveStage([string]$src,[string]$dst,[string]$rel){ foreach($item in (Get-ChildItem -LiteralPath $src -Force)){ $r = if($rel -eq ''){ $item.Name } else { $rel + '\' + $item.Name }; if($item.PSIsContainer){ MoveStage $item.FullName $dst $r } else { $target = Join-Path $dst $r; $dir = [IO.Path]::GetDirectoryName($target); if($dir -and -not (Test-Path -LiteralPath $dir)){ New-Item -ItemType Directory -Path $dir -Force | Out-Null }; if(Test-Path -LiteralPath $target){ $existing = Get-Item -LiteralPath $target -Force; if($existing.IsReadOnly){ $existing.IsReadOnly=$false } }; Copy-Item -LiteralPath $item.FullName -Destination $target -Force; $script:total = $script:total + 1 } } }; foreach($root in $roots){ $stage=Join-Path $new ([string]$root.archivePrefix); if(-not (Test-Path -LiteralPath $stage)){ continue }; $dest=RewritePath ([string]$root.path); Write-Host ('[INFO] workspace ' + $root.name + ' -> ' + $dest); MoveStage $stage $dest ''; Remove-Item -LiteralPath $stage -Recurse -Force }; $stageRoot=Join-Path $new '__workspaces__'; if((Test-Path -LiteralPath $stageRoot) -and (@(Get-ChildItem -LiteralPath $stageRoot -Force).Count -eq 0)){ Remove-Item -LiteralPath $stageRoot -Recurse -Force }; Write-Host ('[OK] workspace files restored: ' + $total)"

rem --- 7. Clean up temporary files -------------------------------------
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%" 2>nul

echo.
echo ========================================
echo   Restore finished
echo ========================================
echo [INFO] You can start DeepSeek Harness again now.
echo [INFO] If it misbehaves, copy the snapshot directory back into
echo        %TARGET_DIR% to roll back.
%DO_PAUSE%
exit /b 0

:dsh_running
echo [ERROR] DeepSeek Harness is running. Quit it completely first
echo         (tray icon - Quit), then run this script again.
%DO_PAUSE%
exit /b 1

:not_our_backup
echo [ERROR] This archive was not created by dsh-backup-rescue
echo         (DSH-MANIFEST.json is missing).
%DO_PAUSE%
exit /b 1

:cancelled
echo [INFO] Cancelled.
%DO_PAUSE%
exit /b 0

:extract_fail
echo [ERROR] Extraction failed, the restore is incomplete.
%DO_PAUSE%
exit /b 1
