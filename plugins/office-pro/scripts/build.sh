#!/usr/bin/env bash
# office-pro vendor 构建：安装运行库到 vendor/node_modules（联网一次）+ 供给中文字体。
# 内网替代：npm --offline --cache <预置缓存目录>，或 npm config set registry <私服>。
# 字体供给序：宿主 momo-studio checkout 拷贝（离线可用）→ 钉版 URL 下载（联网）。
# 来源依据 spec §5.3-4「Noto Sans SC 迁入 vendor」——pdfkit 无内置中文字体，
# 缺字体时 PDF 中文渲染不可用（skill §4 有注册写法）。
set -euo pipefail
cd "$(dirname "$0")/../vendor"
npm install --omit=dev --no-audit --no-fund

FONT_DST="fonts/NotoSansSC-Regular.ttf"
FONT_URL="https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf"
if [ ! -f "$FONT_DST" ]; then
  mkdir -p fonts
  HOST_ROOT="${MOMO_STUDIO_ROOT:-../moo-studio}"
  if [ -f "$HOST_ROOT/electron/resources/fonts/NotoSansSC-Regular.ttf" ]; then
    cp "$HOST_ROOT/electron/resources/fonts/NotoSansSC-Regular.ttf" "$FONT_DST"
    echo "字体已从宿主 checkout 拷贝: $FONT_DST"
  else
    echo "宿主无字体，尝试钉版 URL 下载（离线环境请手动放置 $FONT_DST）"
    curl -fsSL -o "$FONT_DST" "$FONT_URL" || echo "警告: 字体下载失败——PDF 中文生成将不可用（xlsx/pptx/docx 不受影响）"
  fi
fi
echo "vendor 就绪: $(pwd)/node_modules$( [ -f "$FONT_DST" ] && echo " + $FONT_DST" )"
