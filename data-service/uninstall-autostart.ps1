# 卸载本地数据服务的开机自启
#
# 只删除本服务自己创建的两样东西：
#   1. 启动文件夹里的 browser-note-local-service.lnk
#   2. data-service 目录下的 start-hidden.vbs
# 不动启动文件夹里的其它任何内容，也不删除数据文件（notes.json 保留）。
param(
  [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Startup = [Environment]::GetFolderPath('Startup')
$Lnk = Join-Path $Startup 'browser-note-local-service.lnk'
$Vbs = Join-Path $Here 'start-hidden.vbs'

if (Test-Path $Lnk) { Remove-Item -LiteralPath $Lnk -Force; Write-Host "已删除快捷方式：$Lnk" }
else { Write-Host "快捷方式不存在（可能已卸载）：$Lnk" }

if (Test-Path $Vbs) { Remove-Item -LiteralPath $Vbs -Force; Write-Host "已删除：$Vbs" }
else { Write-Host "start-hidden.vbs 不存在" }

if ($RemoveData) {
  $DataDir = Join-Path $Here 'data'
  if (Test-Path $DataDir) { Remove-Item -LiteralPath $DataDir -Recurse -Force; Write-Host "已删除数据目录：$DataDir" }
}

Write-Host ''
Write-Host '已卸载。正在运行的服务进程需要手动结束（任务管理器里找 node.exe）。'
