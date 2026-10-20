<#
  生成应用图标 assets\foryounotes.ico（多种尺寸打包的 ICO），
  并在桌面创建“For You Notes”快捷方式，指向 开启笔记.cmd。

  用法：
    powershell -ExecutionPolicy Bypass -File launcher\Make-Shortcut.ps1
    powershell -ExecutionPolicy Bypass -File launcher\Make-Shortcut.ps1 -IconOnly
#>
[CmdletBinding()]
param(
  [switch]$IconOnly,
  [string]$ShortcutName = 'For You Notes'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$script:AppDir = Split-Path -Parent $PSScriptRoot
$assetDir = Join-Path $script:AppDir 'assets'
if (-not (Test-Path -LiteralPath $assetDir)) { New-Item -ItemType Directory -Path $assetDir -Force | Out-Null }
$icoPath = Join-Path $assetDir 'foryounotes.ico'

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)

  $s = $size / 256.0
  $pad = [Math]::Max(1, [int](9 * $s))
  $rect = New-Object System.Drawing.Rectangle $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
  $r = [int](56 * $s)
  $d = $r * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 110, 168, 254),
    [System.Drawing.Color]::FromArgb(255, 139, 124, 246),
    45.0)
  $g.FillPath($brush, $path)
  $brush.Dispose()

  $dot = [Math]::Max(1.6, $size * 0.10)
  $nodes = @(
    @{ x = $size * 0.50; y = $size * 0.33 },
    @{ x = $size * 0.31; y = $size * 0.69 },
    @{ x = $size * 0.71; y = $size * 0.67 }
  )
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(130, 255, 255, 255)), ([Math]::Max(1, $size * 0.026))
  $g.DrawLine($pen, [single]$nodes[0].x, [single]$nodes[0].y, [single]$nodes[1].x, [single]$nodes[1].y)
  $g.DrawLine($pen, [single]$nodes[0].x, [single]$nodes[0].y, [single]$nodes[2].x, [single]$nodes[2].y)
  $g.DrawLine($pen, [single]$nodes[1].x, [single]$nodes[1].y, [single]$nodes[2].x, [single]$nodes[2].y)
  $pen.Dispose()

  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(246, 255, 255, 255))
  foreach ($n in $nodes) {
    $g.FillEllipse($white, [single]($n.x - $dot), [single]($n.y - $dot), [single]($dot * 2), [single]($dot * 2))
  }
  $white.Dispose()
  $g.Dispose()
  return $bmp
}

function Write-Ico([string]$path, [int[]]$sizes) {
  $blobs = @()
  foreach ($size in $sizes) {
    $bmp = New-IconBitmap $size
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $blobs += , @{ Size = $size; Bytes = $ms.ToArray() }
    $ms.Dispose(); $bmp.Dispose()
  }
  $fs = [System.IO.File]::Create($path)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([UInt16]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]$blobs.Count)
  $offset = 6 + 16 * $blobs.Count
  foreach ($b in $blobs) {
    $dim = if ($b.Size -ge 256) { 0 } else { $b.Size }
    $bw.Write([byte]$dim)
    $bw.Write([byte]$dim)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$b.Bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $b.Bytes.Length
  }
  foreach ($b in $blobs) { $bw.Write($b.Bytes) }
  $bw.Flush(); $bw.Dispose(); $fs.Dispose()
}

Write-Host "生成图标: $icoPath"
Write-Ico -path $icoPath -sizes @(16, 24, 32, 48, 64, 128, 256)
Write-Host ("图标大小: {0} KB" -f [math]::Round((Get-Item -LiteralPath $icoPath).Length / 1KB, 1))

if ($IconOnly) { exit 0 }

$desktop = [Environment]::GetFolderPath('Desktop')
$target = Join-Path $script:AppDir '开启笔记.cmd'
if (-not (Test-Path -LiteralPath $target)) { throw "找不到启动文件: $target" }

$lnk = Join-Path $desktop ($ShortcutName + '.lnk')
if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $target
$sc.WorkingDirectory = $script:AppDir
$sc.IconLocation = "$icoPath,0"
$sc.Description = 'For You Notes · 本地笔记（左栏知识体系图 / 右栏笔记内容）'
$sc.WindowStyle = 7
$sc.Save()
[void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

Write-Host "桌面快捷方式: $lnk"
Write-Host "完成。双击桌面图标即可打开笔记。"
