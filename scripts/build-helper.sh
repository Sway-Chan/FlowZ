#!/usr/bin/env bash
# 交叉编译 FlowZ macOS 提权 helper（Go，无第三方依赖）到两个 mac 架构资源目录。
# 产物随 electron-builder extraResources（resources/mac-${arch} → mac）打进 app 包。
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
echo "[build-helper] done"
