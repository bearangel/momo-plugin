# 插件离线分发包打包（Windows 变体）
#
# 用法（在仓库任意位置均可）：
#   pwsh -File scripts/build-plugin-packages.ps1
#   pwsh -File scripts/build-plugin-packages.ps1 -Root D:\dev\AiProjects\momo-plugin -StudioRoot D:\dev\AiProjects\momo-studio
#
# 产物：dist-release/<id>-<version>[-win32-x64]/ + 同名 .zip + SHA256SUMS.txt
#
# 做四件事：
#   1. 按 plugins/* 复制出「解压即可 dev 装载」的插件根
#   2. codegraph 生成 Windows 变体：manifest 只声明 win32-x64 vendor 归档（sha256 自动回填）
#      + mcp.json 的 command 改 ${pluginRoot}/engine/node.exe
#      原因：宿主安装器会把 manifest 声明的【全部】vendor 归档解压进同一个 engine/，
#            多平台归档共存必坏；且宿主 ${engineNode} 在 win32 解析到无扩展名的
#            engine/node，Windows spawn 不了
#   3. office-pro 补齐中文字体（build.sh 的等价动作，字体源取宿主 checkout）
#   4. 插件自有文本文件行尾归一为 LF —— core.autocrlf=true 的检出是 CRLF，
#      而宿主 parseSkillMd 按 \n 切分 frontmatter，CRLF 会「插件装了但技能列表空」
param(
  [string]$Root = "",
  [string]$StudioRoot = ""
)
$ErrorActionPreference = "Stop"

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path $Root).Path

if (-not $StudioRoot) {
  $candidates = @(
    (Join-Path (Split-Path -Parent $Root) "momo-studio"),
    (Join-Path (Split-Path -Parent $Root) "moo-studio")
  )
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c "electron/package.json")) { $StudioRoot = $c; break }
  }
}

$dist = Join-Path $Root "dist-release"
$plugins = Join-Path $Root "plugins"
New-Item -ItemType Directory -Force $dist | Out-Null
Write-Host "repo   : $Root"
Write-Host "studio : $(if ($StudioRoot) { $StudioRoot } else { '<未找到该 checkout，office-pro 中文字体将缺失>' })"
Write-Host "output : $dist"

function Read-Manifest([string]$dir) {
  Get-Content (Join-Path $dir "momo-plugin.json") -Raw | ConvertFrom-Json
}

# 插件自有文本归一 LF：跳过 engine/（上游二进制分发）与 node_modules/（第三方原样）
function Convert-ToLf([string]$dir) {
  $exts = @('.md', '.markdown', '.yaml', '.yml', '.json', '.js', '.cjs', '.mjs', '.html', '.css', '.txt', '.sh', '.cmd')
  $count = 0
  Get-ChildItem $dir -Recurse -File | Where-Object {
    ($exts -contains $_.Extension.ToLower()) -and
    ($_.FullName -notmatch '\\engine\\') -and
    ($_.FullName -notmatch '\\node_modules\\')
  } | ForEach-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    if (-not ($bytes -contains 13)) { return }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $text = $text -replace "`r`n", "`n" -replace "`r", "`n"
    [System.IO.File]::WriteAllText($_.FullName, $text, (New-Object System.Text.UTF8Encoding($false)))
    $count++
  }
  "  LF normalized: $count files"
}

function New-Package([string]$srcDir, [string]$name, [scriptblock]$postCopy, [string[]]$excludeDirs = @()) {
  $target = Join-Path $dist $name
  Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $target | Out-Null
  # robocopy 而非 Copy-Item：后者对「含子目录的 wildcard 源 → 新目标」会报
  # "Container cannot be copied onto existing leaf item"，且长路径更稳
  $rcArgs = @($srcDir, $target, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
  if ($excludeDirs.Count -gt 0) { $rcArgs += "/XD"; $rcArgs += $excludeDirs }
  robocopy @rcArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败：$srcDir -> $target (exit $LASTEXITCODE)" }
  if ($postCopy) { & $postCopy $target }
  Convert-ToLf $target
  $target
}

# ---- 1. codegraph（Windows 变体）----
# 刻意【不】把已解压的 engine/ 打进 zip：宿主 zip 安装会在 finalizePluginInstall 里
# 从 vendor 归档解压出 engine/，两样都带 = 解压总量翻倍（engine 253MB + 归档 53MB
# = 303MB）直接撞 200MB 解压上限。只带归档 → 解压总量 ~53MB。
# dev 目录装载场景需先自己解压归档：tar -xzf vendor/codegraph-win32-x64.tar.gz -C engine
$cgSrc = Join-Path $plugins "codegraph"
$cgManifest = Read-Manifest $cgSrc
$cgName = "codegraph-$($cgManifest.version)-win32-x64"
$null = New-Package $cgSrc $cgName {
  param($t)
  $arcFile = "vendor/codegraph-win32-x64.tar.gz"
  $arcAbs = Join-Path $t $arcFile
  if (-not (Test-Path $arcAbs)) {
    throw "codegraph 缺 $arcFile —— 先从上游 colbymchenry/codegraph 对应版本取 win32-x64 包并解压出 engine/，再压成该归档"
  }
  $sha = (Get-FileHash $arcAbs -Algorithm SHA256).Hash.ToLower()
  $m = Get-Content (Join-Path $t "momo-plugin.json") -Raw | ConvertFrom-Json
  $m.vendor = [pscustomobject]@{
    archives = @([pscustomobject]@{ file = $arcFile; sha256 = $sha; maxEntries = 20000 })
    probe    = "engine/bin/codegraph"
  }
  $m | ConvertTo-Json -Depth 32 | Set-Content (Join-Path $t "momo-plugin.json") -Encoding utf8
  @'
{
  "servers": {
    "codegraph": {
      "command": "${pluginRoot}/engine/node.exe",
      "args": [
        "${pluginRoot}/bin/boot.js",
        "--engine", "${pluginRoot}/engine/bin/codegraph.cmd",
        "--root", "${config.workspaceRoot}"
      ],
      "env": {
        "CODEGRAPH_NO_DOWNLOAD": "1",
        "CODEGRAPH_DIR": ".momo-codegraph"
      }
    }
  }
}
'@ | Set-Content (Join-Path $t "mcp/mcp.json") -Encoding utf8
  "  codegraph vendor sha = $sha"
} -excludeDirs @((Join-Path $cgSrc "engine"))

# ---- 2. email ----
$emManifest = Read-Manifest (Join-Path $plugins "email")
$emName = "email-$($emManifest.version)"
$null = New-Package (Join-Path $plugins "email") $emName

# ---- 3. office-pro（含中文字体）----
$ofManifest = Read-Manifest (Join-Path $plugins "office-pro")
$ofName = "office-pro-$($ofManifest.version)"
$null = New-Package (Join-Path $plugins "office-pro") $ofName {
  param($t)
  $fonts = Join-Path $t "vendor/fonts"
  New-Item -ItemType Directory -Force $fonts | Out-Null
  if ($StudioRoot) {
    $src = Join-Path $StudioRoot "electron/resources/fonts/NotoSansSC-Regular.ttf"
    if (Test-Path $src) { Copy-Item $src (Join-Path $fonts "NotoSansSC-Regular.ttf") -Force }
    else { Write-Warning "未找到中文字体源：$src（PDF 中文将不可用）" }
  } else {
    Write-Warning "未定位宿主 checkout，跳过中文字体（PDF 中文将不可用）"
  }
}

# ---- 4. dev-team（纯声明式：manifest + agents + skills）----
$dtManifest = Read-Manifest (Join-Path $plugins "dev-team")
$dtName = "dev-team-$($dtManifest.version)"
$null = New-Package (Join-Path $plugins "dev-team") $dtName

# ---- 5. 打 zip ----
$names = @($cgName, $emName, $ofName, $dtName)
foreach ($n in $names) {
  $zip = Join-Path $dist "$n.zip"
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Push-Location $dist
  tar -a -c -f "$n.zip" $n
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "zip 失败：$n (exit $code)" }
  Write-Host "  packed $n.zip"
}

# ---- 6. SHA256SUMS ----
$lines = foreach ($n in $names) {
  "{0}  {1}" -f (Get-FileHash (Join-Path $dist "$n.zip") -Algorithm SHA256).Hash.ToLower(), "$n.zip"
}
$lines | Set-Content (Join-Path $dist "SHA256SUMS.txt") -Encoding ascii
Write-Host ""
$lines
