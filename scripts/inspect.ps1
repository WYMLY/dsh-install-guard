# inspect.ps1 - static check of a downloaded file before it runs.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File inspect.ps1 -Path 'C:\path\thing.exe'
param(
  [Parameter(Mandatory = $true)][string]$Path
)

if (-not (Test-Path -LiteralPath $Path)) { "MISSING: $Path"; exit 2 }
$fi = Get-Item -LiteralPath $Path
$size = $fi.Length

"=== FILE ==="
"path      : $($fi.FullName)"
"size      : $size bytes"
"created   : $($fi.CreationTime.ToString('o'))"
"modified  : $($fi.LastWriteTime.ToString('o'))"

"=== HASH ==="
$h = Get-FileHash -LiteralPath $Path -Algorithm SHA256
"SHA256    : $($h.Hash)"

"=== SIGNATURE ==="
$sig = Get-AuthenticodeSignature -LiteralPath $Path
"status    : $($sig.Status)"
if ($sig.SignerCertificate) {
  "signer    : $($sig.SignerCertificate.Subject)"
  "issuer    : $($sig.SignerCertificate.Issuer)"
} else {
  "signer    : (none - UNSIGNED)"
}

"=== ZONE / MOTW ==="
$zone = $null
try { $zone = Get-Content -LiteralPath $Path -Stream Zone.Identifier -ErrorAction Stop } catch { }
if ($zone) { $zone } else { "(no Zone.Identifier)" }

"=== VERSION INFO ==="
try {
  $vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($fi.FullName)
  "company   : $($vi.CompanyName)"
  "product   : $($vi.ProductName)"
  "version   : $($vi.FileVersion)"
  "desc      : $($vi.FileDescription)"
  "original  : $($vi.OriginalFilename)"
} catch { "(no version info)" }

"=== BYTES ==="
$fs = [System.IO.File]::OpenRead($fi.FullName)
try {
  $head = New-Object byte[] 16
  $null = $fs.Read($head, 0, 16)
  "first16   : " + (($head | ForEach-Object { $_.ToString('x2') }) -join ' ')
  $isMz = ($head[0] -eq 0x4D -and $head[1] -eq 0x5A)
  "isPE(MZ)  : $isMz"
  $fs.Position = [Math]::Max(0, $size - 4)
  $tail = New-Object byte[] 4
  $null = $fs.Read($tail, 0, 4)
  "last4     : " + (($tail | ForEach-Object { $_.ToString('x2') }) -join ' ')
} finally { $fs.Close() }

# read head + tail as latin1 for marker / string scanning
function Read-Block($filePath, $offset, $count) {
  $s = [System.IO.File]::OpenRead($filePath)
  try {
    $s.Position = $offset
    $buf = New-Object byte[] $count
    $n = $s.Read($buf, 0, $count)
    if ($n -lt $count) { $buf = $buf[0..([Math]::Max(0, $n - 1))] }
    return [System.Text.Encoding]::GetEncoding(28591).GetString($buf)
  } finally { $s.Close() }
}

$headLen = [int][Math]::Min(16MB, $size)
$text = Read-Block $fi.FullName 0 $headLen
if ($size -gt 16MB) { $text += Read-Block $fi.FullName ([Math]::Max(0, $size - 1MB)) 1MB }

"=== PACKER / INSTALLER MARKERS ==="
$markers = [ordered]@{
  'NSIS (NullsoftInst)' = 'NullsoftInst'
  'Inno Setup'          = 'Inno Setup'
  'PyInstaller'         = 'PyInstaller'
  'Nuitka'              = 'Nuitka'
  'Electron'            = 'ELECTRON_RUN_AS_NODE'
  'MSI (MSCF cabinet)'  = 'MSCF'
  'ZIP local header'    = "PK" + [char]3 + [char]4
  '7z magic'            = [char]0x37 + [char]0x7A + [char]0xBC + [char]0xAF + [char]0x27 + [char]0x1C
}
foreach ($k in $markers.Keys) {
  $idx = $text.IndexOf($markers[$k])
  if ($idx -ge 0) { "  $k : FOUND at offset ~$idx" } else { "  $k : -" }
}

# runtime signature of dotnet / pyinstaller bootloader style
if ($text.IndexOf('This program cannot be run in DOS mode') -ge 0) { "  DOS stub present : yes" }

"=== STRINGS: links ==="
$urls = [regex]::Matches($text, 'https?://[A-Za-z0-9\-\._~:/#%\+=\?&]{4,90}') | ForEach-Object { $_.Value } | Sort-Object -Unique
if ($urls) { $urls | Select-Object -First 40 } else { "  (none in scanned range - possible string encryption)" }

"=== STRINGS: ipv4 ==="
$ips = [regex]::Matches($text, '\b(?:\d{1,3}\.){3}\d{1,3}\b') | ForEach-Object { $_.Value } |
  Where-Object { $_ -notmatch '^(0\.|127\.|255\.|1\.0\.0\.|10\.|192\.168\.)' } | Sort-Object -Unique
if ($ips) { $ips | Select-Object -First 20 } else { "  (none)" }

"=== STRINGS: red flags ==="
$flags = @(
  'BOT DETECTION', 'threshold', 'telemetry', 'DisableBlockAtFirstSeen',
  'Defender', 'sandbox', 'RDP Session', 'vmware', 'VirtualBox', 'qemu',
  'AppData\\Roaming', 'Users\\Public', 'programdata', 'schtasks', 'CreateService',
  'reg add', 'powershell -', 'FromBase64String'
)
foreach ($f in $flags) {
  $idx = $text.IndexOf($f, [StringComparison]::OrdinalIgnoreCase)
  if ($idx -ge 0) { "  $f : hit at ~$idx" }
}

"=== DONE ==="
