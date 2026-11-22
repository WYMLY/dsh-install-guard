# diff-snapshot.ps1 - compare two snapshot.json files, print what appeared or disappeared.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File diff-snapshot.ps1 -Before before.json -After after.json
param(
  [Parameter(Mandatory = $true)][string]$Before,
  [Parameter(Mandatory = $true)][string]$After
)

$b = Get-Content -LiteralPath $Before -Raw | ConvertFrom-Json
$a = Get-Content -LiteralPath $After  -Raw | ConvertFrom-Json

$categories = @('tasks', 'services', 'run', 'startup', 'wmi', 'listen', 'remote', 'programfiles')

function Index($list) {
  $h = @{}
  foreach ($item in @($list)) {
    if ($null -ne $item -and $item.Key) { $h[[string]$item.Key] = [string]$item.Action }
  }
  return $h
}

$suspect = @()
foreach ($c in $categories) {
  $hb = Index $b.$c
  $ha = Index $a.$c
  $added = @($ha.Keys | Where-Object { -not $hb.ContainsKey($_) } | Sort-Object)
  $removed = @($hb.Keys | Where-Object { -not $ha.ContainsKey($_) } | Sort-Object)

  "=== $c : +$($added.Count) / -$($removed.Count) ==="
  foreach ($k in $added) {
    "  + $k  ->  $($ha[$k])"
    $blob = "$k $($ha[$k])"
    if ($blob -match 'Public\\|\\Temp\\|AppData\\Local\\Temp|AppData\\Roaming|ProgramData') { $suspect += "[$c] $blob" }
  }
  foreach ($k in $removed) { "  - $k" }
}

if ($suspect.Count -gt 0) {
  ""
  "### SUSPECT (points into user-writable paths) ###"
  foreach ($s in $suspect) { "  ! $s" }
} else {
  ""
  "### no entry pointing into user-writable paths ###"
}
