# sweep-hash.ps1 - hunt every copy of known-bad payloads by hash (and optional size) across drives.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File sweep-hash.ps1 -Hashes 5AA5...,91AA...
#   powershell -NoProfile -ExecutionPolicy Bypass -File sweep-hash.ps1 -Hashes 5AA5... -Sizes 3387424,2413600
param(
  [Parameter(Mandatory = $true)][string[]]$Hashes,
  [int[]]$Sizes = @(),
  [string[]]$Roots = @('C:\', 'D:\'),
  [string[]]$SkipDirs = @(
    'C:\Windows\WinSxS', 'C:\Windows\Installer', 'C:\$Recycle.Bin',
    'C:\System Volume Information', 'C:\Windows\servicing'
  )
)

$wanted = @{}
foreach ($h in $Hashes) { $wanted[$h.ToUpperInvariant()] = $true }
$sizeSet = @{}
foreach ($s in $Sizes) { $sizeSet[[int64]$s] = $true }

"scanning: $($Roots -join ', ')"
"hashes  : $($wanted.Keys -join ', ')"
if ($sizeSet.Count -gt 0) { "sizes   : $($sizeSet.Keys -join ', ') (pre-filter ON)" }

$hits = @()
$scanned = 0
$start = Get-Date

foreach ($root in $Roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Write-Progress -Activity "sweep $root" -Status "$scanned files"
  Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $skip = $false
    foreach ($d in $SkipDirs) { if ($_.FullName.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { $skip = $true; break } }
    if ($skip) { return }

    $scanned++
    if ($sizeSet.Count -gt 0) {
      if (-not $sizeSet.ContainsKey([int64]$_.Length)) { return }
    }
    try {
      $h = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
    } catch { return }
    if ($wanted.ContainsKey($h)) {
      $hit = [pscustomobject]@{
        Hash    = $h
        Size    = $_.Length
        Path    = $_.FullName
        Created = $_.CreationTime.ToString('o')
        Written = $_.LastWriteTime.ToString('o')
      }
      $script:hits += $hit
      "HIT  $($hit.Path)  [$($hit.Size)]  $($hit.Hash)"
    }
  }
}

$mins = [Math]::Round(((Get-Date) - $start).TotalMinutes, 1)
""
"scanned $scanned files in $mins min"
if ($hits.Count -eq 0) {
  "RESULT: 0 hits - no copy of these hashes found"
} else {
  "RESULT: $($hits.Count) hits"
  $hits | Format-Table -Auto
}
