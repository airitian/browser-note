# 安装本地数据服务的开机自启
#
# 做三件事：
#   1. 解析 node.exe 的绝对路径（优先 PATH，其次 WorkBuddy 内置版本，最后常见安装位置）
#   2. 生成 start-hidden.vbs（用 wscript 隐藏启动，避免开机弹黑色控制台窗口）
#   3. 在「启动」文件夹放一个快捷方式，指向 wscript + 那个 vbs
#
# 卸载：运行同目录的 uninstall-autostart.ps1
#
# 注意：本脚本只创建/删除【自己那一个】快捷方式与 vbs，不碰启动文件夹里的其它任何东西。
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $Here 'server.mjs'
if (-not (Test-Path $Server)) { throw "找不到 server.mjs：$Server" }

$Startup = [Environment]::GetFolderPath('Startup')
$Vbs = Join-Path $Here 'start-hidden.vbs'
$Lnk = Join-Path $Startup 'browser-note-local-service.lnk'

# ---- 1. 解析 node.exe ----
function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cands = @()
  $wb = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
  if (Test-Path $wb) {
    $cands += Get-ChildItem -Path $wb -Filter 'node.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
              Sort-Object FullName -Descending | ForEach-Object { $_.FullName }
  }
  foreach ($p in @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )) { if ($p -and (Test-Path $p)) { $cands += $p } }
  return ($cands | Select-Object -First 1)
}

$node = Find-Node
if (-not $node) { throw '找不到 node.exe。请先安装 Node.js，或手动运行 server.mjs。' }
Write-Host "[1/3] node.exe = $node"

# ---- 2. 生成隐藏启动用的 vbs ----
# window style 0 = 完全隐藏（不开控制台窗口）；False = 不等待（脚本立即退出）
$vbsBody = @"
Set sh = CreateObject("WScript.Shell")
sh.Run """$node"" ""$Server""", 0, False
"@
Set-Content -Path $Vbs -Value $vbsBody -Encoding ASCII
Write-Host "[2/3] 已生成 $Vbs"

# ---- 3. 创建启动快捷方式 ----
if (Test-Path $Lnk) {
  if (-not $Force) {
    Write-Host "[3/3] 启动快捷方式已存在：$Lnk"
    Write-Host '      如需重建，请加 -Force 参数重跑本脚本。'
    exit 0
  }
  Remove-Item -LiteralPath $Lnk -Force
}
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($Lnk)
$sc.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$sc.Arguments = '"' + $Vbs + '"'
$sc.WorkingDirectory = $Here
$sc.WindowStyle = 7
$sc.Description = 'BrowserNote local data service'
$sc.Save()
Write-Host "[3/3] 已创建启动快捷方式：$Lnk"
Write-Host ''
Write-Host '完成。重启（或从「启动」文件夹手动运行）后服务会自动起来。'
Write-Host '验证：curl http://127.0.0.1:8787/health'
