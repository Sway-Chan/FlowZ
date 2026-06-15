#!/usr/bin/env bash
# 交叉编译 FlowZ 提权 helper（Go）：macOS（helper/，纯 stdlib，两 mac 架构）+ Windows（helper-win/，winio+x-sys，amd64）。
# 产物随 electron-builder extraResources（resources/mac-${arch} → mac；resources/win）打进 app 包。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/helper"
OUT_NAME="com.flowz.helper"

if ! command -v go >/dev/null 2>&1; then
  if [ -n "${REQUIRE_HELPER:-}" ]; then
    echo "[build-helper] REQUIRE_HELPER 已设但未找到 go 工具链 —— 提权 helper 是发布必需组件，终止以避免静默发布无 helper 的包" >&2
    exit 1
  fi
  echo "[build-helper] 未找到 go 工具链，跳过 helper 构建（提权 helper 不打包，运行时回退 osascript 看护脚本；发布构建经 setup-go 保证可用）" >&2
  exit 0
fi

build() {
  local arch="$1" goarch="$2"
  local out="$ROOT/resources/mac-$arch/$OUT_NAME"
  echo "[build-helper] mac-$arch ($goarch) → $out"
  ( cd "$SRC" && GOOS=darwin GOARCH="$goarch" CGO_ENABLED=0 \
      go build -trimpath -ldflags="-s -w" -o "$out" . )
  chmod 755 "$out"
}

build arm64 arm64
build x64 amd64

# Windows 提权服务 helper（独立 module helper-win/，含 vendor/ → -mod=vendor 离线构建）。
# 输出到 resources/win/（与 sing-box.exe / libcronet.dll 同目录，对齐 ResourceManager.getWinHelperPath 与
# getPlatformResourceDir 的 win 分支）。GOOS=windows 从任意宿主交叉编译（纯 Go + winio/x-sys，CGO 关）。
WIN_SRC="$ROOT/helper-win"
if [ -d "$WIN_SRC" ]; then
  WIN_OUT="$ROOT/resources/win/com.flowz.helper.exe"
  echo "[build-helper] win-x64 (amd64) → $WIN_OUT"
  mkdir -p "$ROOT/resources/win"
  ( cd "$WIN_SRC" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
      go build -mod=vendor -trimpath -ldflags="-s -w" -o "$WIN_OUT" . )
fi
echo "[build-helper] done"
