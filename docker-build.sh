#!/usr/bin/env bash
# docker-build.sh — 用 Docker 编译 HorseMD Linux deb 包
#
# 用法：
#   ./docker-build.sh            # 构建镜像并编译，产物输出到 ./dist-linux/
#   ./docker-build.sh --no-cache  # 强制不使用缓存重新构建镜像
#
# 前提：已安装并启动 Docker

set -euo pipefail

IMAGE_NAME="horsemd-builder"
OUTPUT_DIR="$(pwd)/dist-linux"
DOCKERFILE="Dockerfile.deb"

# 解析参数
NO_CACHE=""
for arg in "$@"; do
  case $arg in
    --no-cache) NO_CACHE="--no-cache" ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

echo "================================================"
echo "  HorseMD Linux deb 构建"
echo "================================================"
echo "  镜像名称：$IMAGE_NAME"
echo "  产物目录：$OUTPUT_DIR"
echo ""

# 确保输出目录存在
mkdir -p "$OUTPUT_DIR"

# Step 1: 构建 Docker 镜像
echo ">>> Step 1/2: 构建 Docker 镜像（首次较慢，后续有缓存）..."
docker build \
  $NO_CACHE \
  -f "$DOCKERFILE" \
  -t "$IMAGE_NAME" \
  .

echo ""
echo ">>> Step 2/2: 在容器内编译并打包 deb..."
# 挂载 dist-linux 目录，容器内构建完成后将 dist/ 内容复制进去
docker run --rm \
  --name horsemd-build-run \
  -v "$OUTPUT_DIR:/output" \
  "$IMAGE_NAME"

echo ""
echo "================================================"
echo "  构建完成！产物在：$OUTPUT_DIR"
echo "================================================"
ls -lh "$OUTPUT_DIR"/*.deb 2>/dev/null || echo "  ⚠️  未找到 .deb 文件，请检查构建日志"
