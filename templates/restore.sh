#!/usr/bin/env bash
# restore.sh - DSH 备份恢复器（macOS / Linux，独立于 DSH 运行）
#
# 配套 dsh-backup-rescue：
#   ZIP 根目录 = $DSH_HOME 的内容，清单文件为 DSH-MANIFEST.json。
#
# 加密备份（.zip.enc）支持两种封装：
#   DSHBK002（0.4.1 起）PBKDF2-SHA256 + AES-256-CBC + HMAC-SHA256
#   DSHBK001（0.3.x-0.4.0）scrypt + AES-256-GCM
# 优先用 node（DSH 自带或系统安装的），没有 node 时退回 python3：
#   - DSHBK002 用 python3 + openssl（两者都是系统自带）
#   - DSHBK001 用 python3 + pycryptodome（pip install pycryptodome）
#
# 用法: ./restore.sh /path/to/dsh-backup-xxx.zip [目标目录] [密码]
#
# 自动化/测试用环境变量：
#   DSH_RESTORE_TARGET        等价于第二个参数
#   DSH_RESTORE_PASSWORD      等价于第三个参数
#   DSH_RESTORE_YES=1         不询问确认
#   DSH_RESTORE_SKIP_PROCESS_CHECK=1  跳过“DSH 正在运行”检查
set -euo pipefail

BACKUP_PATH="${1:-}"
TARGET_DIR="${DSH_RESTORE_TARGET:-${2:-$HOME/.dsh}}"
PASSWORD="${DSH_RESTORE_PASSWORD:-${3:-}}"

if [[ -z "$BACKUP_PATH" ]]; then
  read -r -p "备份 zip 路径: " BACKUP_PATH
fi
[[ -f "$BACKUP_PATH" ]] || { echo "[ERROR] 文件不存在: $BACKUP_PATH" >&2; exit 1; }

IS_ENCRYPTED=false
case "$BACKUP_PATH" in
  *.enc) IS_ENCRYPTED=true ;;
esac

if $IS_ENCRYPTED && [[ -z "$PASSWORD" ]]; then
  read -r -s -p "请输入加密备份密码: " PASSWORD
  echo
fi

if [[ "${DSH_RESTORE_SKIP_PROCESS_CHECK:-}" != "1" ]] && pgrep -f "deepseek-harness" >/dev/null 2>&1; then
  echo "[ERROR] DSH 正在运行，请先完全退出再恢复。" >&2
  exit 1
fi

# 解压工具：优先 unzip，最小化系统（只有 python3）时退回 zipfile
HAVE_UNZIP=0
command -v unzip >/dev/null 2>&1 && HAVE_UNZIP=1
if [[ $HAVE_UNZIP -eq 0 ]] && ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] 需要 unzip 或 python3 才能解压备份" >&2
  exit 1
fi

echo "========================================"
echo "  DSH 备份恢复工具 v0.4.1"
echo "========================================"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  for candidate in "$HOME"/.dsh/dsh-runtimes/*/dependencies/node/bin/node; do
    [[ -x "$candidate" ]] && { echo "$candidate"; return 0; }
  done
  return 1
}

WORKING_FILE="$BACKUP_PATH"
TEMP_DIR=""
if $IS_ENCRYPTED; then
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT
  MAGIC="$(head -c 8 "$BACKUP_PATH")"
  echo "[INFO] 正在解密（格式 $MAGIC）..."

  export DSH_ARCHIVE="$BACKUP_PATH" DSH_PASSWORD="$PASSWORD" DSH_OUT="$TEMP_DIR/backup.zip"
  NODE_BIN="$(find_node || true)"

  if [[ -n "$NODE_BIN" ]]; then
    "$NODE_BIN" --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { pbkdf2Sync, scryptSync, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";
const raw = readFileSync(process.env.DSH_ARCHIVE);
const pass = process.env.DSH_PASSWORD;
const magic = raw.subarray(0, 8).toString("latin1");
let plain;
if (magic === "DSHBK002") {
  const salt = raw.subarray(8, 24), iv = raw.subarray(24, 40), mac = raw.subarray(40, 72), body = raw.subarray(72);
  const all = pbkdf2Sync(pass, salt, 200000, 64, "sha256");
  const key = all.subarray(0, 32), mk = all.subarray(32, 64);
  const want = createHmac("sha256", mk).update(raw.subarray(0, 40)).update(body).digest();
  if (want.length !== mac.length || !timingSafeEqual(want, mac)) throw new Error("wrong password");
  const d = createDecipheriv("aes-256-cbc", key, iv);
  plain = Buffer.concat([d.update(body), d.final()]);
} else if (magic === "DSHBK001") {
  const salt = raw.subarray(8, 24), iv = raw.subarray(24, 36), tag = raw.subarray(36, 52), body = raw.subarray(52);
  const d = createDecipheriv("aes-256-gcm", scryptSync(pass, salt, 32), iv);
  d.setAuthTag(tag);
  plain = Buffer.concat([d.update(body), d.final()]);
} else {
  throw new Error("unknown encryption wrapper: " + magic);
}
writeFileSync(process.env.DSH_OUT, plain);
console.log("[OK] 解密完成");
' || { echo "[ERROR] 解密失败：密码不正确，或文件已损坏。" >&2; exit 1; }
  elif [[ "$MAGIC" == "DSHBK002" ]] && command -v python3 >/dev/null && command -v openssl >/dev/null; then
    # 没有 node：python3 负责 PBKDF2 + HMAC 校验，openssl 负责 AES-256-CBC
    python3 - "$BACKUP_PATH" "$PASSWORD" "$TEMP_DIR/backup.zip" <<'PY' || { echo "[ERROR] 解密失败：密码不正确，或文件已损坏。" >&2; exit 1; }
import hashlib, hmac, os, subprocess, sys

archive, password, out = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(archive, 'rb').read()
if raw[:8] != b'DSHBK002':
    sys.exit('not a DSHBK002 archive')
salt, iv, mac, body = raw[8:24], raw[24:40], raw[40:72], raw[72:]
derived = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 200000, 64)
key, mac_key = derived[:32], derived[32:]
want = hmac.new(mac_key, raw[:40] + body, hashlib.sha256).digest()
if not hmac.compare_digest(want, mac):
    sys.exit('wrong password')
res = subprocess.run(
    ['openssl', 'enc', '-d', '-aes-256-cbc', '-K', key.hex(), '-iv', iv.hex()],
    input=body, capture_output=True,
)
if res.returncode != 0:
    sys.exit(res.stderr.decode('utf-8', 'replace'))
open(out, 'wb').write(res.stdout)
print('[OK] 解密完成（python3 + openssl）')
PY
  elif [[ "$MAGIC" == "DSHBK001" ]] && command -v python3 >/dev/null; then
    python3 - "$BACKUP_PATH" "$PASSWORD" "$TEMP_DIR/backup.zip" <<'PY' || { echo "[ERROR] 解密失败：需要 pycryptodome（pip install pycryptodome）。" >&2; exit 1; }
import sys
try:
    from Crypto.Cipher import AES
    from Crypto.Protocol.KDF import scrypt
except ImportError:
    sys.exit('pycryptodome missing')

archive, password, out = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(archive, 'rb').read()
if raw[:8] != b'DSHBK001':
    sys.exit('not a DSHBK001 archive')
salt, iv, tag, body = raw[8:24], raw[24:36], raw[36:52], raw[52:]
key = scrypt(password.encode(), salt, 32, N=2**14, r=8, p=1, dkLen=32)
cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
plain = cipher.decrypt_and_verify(body, tag)
open(out, 'wb').write(plain)
print('[OK] 解密完成（python3 + pycryptodome）')
PY
  else
    echo "[ERROR] 无法解密（格式 $MAGIC）：没有可用的 node / python3 解密环境。" >&2
    echo "        DSHBK002 需要 node 或 python3+openssl；DSHBK001 需要 node 或 pycryptodome。" >&2
    exit 1
  fi

  WORKING_FILE="$TEMP_DIR/backup.zip"
fi

has_manifest() {
  if [[ $HAVE_UNZIP -eq 1 ]]; then
    unzip -l "$WORKING_FILE" 2>/dev/null | grep -q "DSH-MANIFEST.json"
  else
    python3 - "$WORKING_FILE" <<'PY'
import sys, zipfile
try:
    names = zipfile.ZipFile(sys.argv[1]).namelist()
except Exception:
    sys.exit(1)
sys.exit(0 if 'DSH-MANIFEST.json' in names else 1)
PY
  fi
}

if ! has_manifest; then
  echo "[ERROR] 不是 dsh-backup-rescue 生成的备份（缺少 DSH-MANIFEST.json）。" >&2
  exit 1
fi

if [[ $HAVE_UNZIP -eq 1 ]]; then
  unzip -p "$WORKING_FILE" DSH-MANIFEST.json | head -40
else
  python3 - "$WORKING_FILE" <<'PY'
import json, sys, zipfile
raw = zipfile.ZipFile(sys.argv[1]).read('DSH-MANIFEST.json').decode('utf-8', 'replace')
try:
    data = json.loads(raw)
    for key in ('createdAt', 'dshHome', 'fileCount', 'totalBytes', 'encrypted'):
        if key in data:
            print(f'  {key}: {data[key]}')
except Exception:
    print(raw[:1500])
PY
fi
echo
if [[ "${DSH_RESTORE_YES:-}" != "1" ]]; then
  read -r -p "恢复到 $TARGET_DIR ? (Y/N): " CONFIRM
  [[ "${CONFIRM:-}" =~ ^[Yy]$ ]] || { echo "[INFO] 已取消。"; exit 0; }
fi

mkdir -p "$TARGET_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
SNAP="$TARGET_DIR/.backup-snapshot/sh-$STAMP"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" ${TEMP_DIR:+"$TEMP_DIR"}' EXIT

echo "[INFO] 解压到临时目录..."
if [[ $HAVE_UNZIP -eq 1 ]]; then
  unzip -q "$WORKING_FILE" -d "$TMP"
else
  python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$WORKING_FILE" "$TMP"
fi

COPIED=0
while IFS= read -r rel; do
  [[ -z "$rel" ]] && continue
  if [[ -f "$TARGET_DIR/$rel" ]]; then
    mkdir -p "$SNAP/$(dirname "$rel")"
    cp -p "$TARGET_DIR/$rel" "$SNAP/$rel"
    COPIED=$((COPIED + 1))
  fi
done < <(cd "$TMP" && find . -type f ! -name 'DSH-MANIFEST.json' -print | sed 's|^\./||')

echo "[INFO] 写入 $TARGET_DIR ..."
(cd "$TMP" && find . -type f ! -name 'DSH-MANIFEST.json' -print0 | while IFS= read -r -d '' f; do
  rel="${f#./}"
  mkdir -p "$TARGET_DIR/$(dirname "$rel")"
  cp -p "$f" "$TARGET_DIR/$rel"
done)

echo "========================================"
echo "  恢复完成（原有 $COPIED 个文件已快照到 $SNAP）"
echo "========================================"
echo "[INFO] 现在可以重新启动 DSH。"
