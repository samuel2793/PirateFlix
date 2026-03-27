param([string]$BaseDir, [string]$OutFile)
$ErrorActionPreference = 'SilentlyContinue'

function Get-SizeStr($dir) {
    if (-not (Test-Path $dir)) { return "0 bytes|0" }
    $files = Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue
    $count = @($files).Count
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    if (-not $bytes) { $bytes = 0 }
    if ($bytes -ge 1GB) { $s = '{0:N2} GB' -f ($bytes / 1GB) }
    elseif ($bytes -ge 1MB) { $s = '{0:N1} MB' -f ($bytes / 1MB) }
    elseif ($bytes -ge 1KB) { $s = '{0:N0} KB' -f ($bytes / 1KB) }
    else { $s = "$bytes bytes" }
    return "$s|$count"
}

$wt = Get-SizeStr (Join-Path $BaseDir 'server\storage\webtorrent')
$tc = Get-SizeStr (Join-Path $BaseDir 'server\storage\transcoded')

@(
    "WT_SIZE=$($wt.Split('|')[0])"
    "WT_FILES=$($wt.Split('|')[1])"
    "TC_SIZE=$($tc.Split('|')[0])"
    "TC_FILES=$($tc.Split('|')[1])"
) | Set-Content -Encoding ascii $OutFile
