# snapshot.ps1 - capture autostart / persistence baseline before installing something.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File snapshot.ps1 -Out C:\tmp\before.json
param(
  [string]$Out = "$env:TEMP\inspect-snapshot.json"
)

function Safe($block) {
  try { & $block } catch { @() }
}

$tasks = Safe {
  Get-ScheduledTask -ErrorAction Stop | ForEach-Object {
    $acts = @()
    foreach ($a in $_.Actions) {
      if ($a.Execute) { $acts += ("{0} {1}" -f $a.Execute, $a.Arguments).Trim() }
      elseif ($a.ClassId) { $acts += ("COM:{0}" -f $a.ClassId) }
    }
    [pscustomobject]@{
      Key    = "$($_.TaskPath)$($_.TaskName)"
      Action = ($acts -join ' | ')
      Author = $_.Author
    }
  }
}

$services = Safe {
  Get-CimInstance Win32_Service -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{ Key = $_.Name; Start = $_.StartMode; Path = $_.PathName }
  }
}

$runKeys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce',
  'HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Run',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce'
)
$run = Safe {
  foreach ($k in $runKeys) {
    if (Test-Path $k) {
      $item = Get-ItemProperty $k
      foreach ($p in $item.PSObject.Properties) {
        if ($p.Name -notlike 'PS*') { [pscustomobject]@{ Key = "$k :: $($p.Name)"; Action = [string]$p.Value } }
      }
    }
  }
}

$startupDirs = @(
  [Environment]::GetFolderPath('Startup'),
  [Environment]::GetFolderPath('CommonStartup')
)
$startup = Safe {
  foreach ($d in $startupDirs) {
    if ($d -and (Test-Path $d)) {
      Get-ChildItem -LiteralPath $d -File -Force | ForEach-Object { [pscustomobject]@{ Key = $_.FullName; Action = '' } }
    }
  }
}

$wmi = Safe {
  Get-CimInstance -Namespace root\subscription -ClassName __EventFilter -ErrorAction Stop |
    ForEach-Object { [pscustomobject]@{ Key = "filter:$($_.Name)"; Action = $_.Query } }
  Get-CimInstance -Namespace root\subscription -ClassName CommandLineEventConsumer -ErrorAction Stop |
    ForEach-Object { [pscustomobject]@{ Key = "cmdline:$($_.Name)"; Action = $_.CommandLineTemplate } }
  Get-CimInstance -Namespace root\subscription -ClassName ActiveScriptEventConsumer -ErrorAction Stop |
    ForEach-Object { [pscustomobject]@{ Key = "script:$($_.Name)"; Action = $_.ScriptText } }
}

$listen = Safe {
  Get-NetTCPConnection -State Listen -ErrorAction Stop |
    ForEach-Object { [pscustomobject]@{ Key = "$($_.LocalAddress):$($_.LocalPort)"; Action = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } }
}

$remote = Safe {
  Get-NetTCPConnection -State Established -ErrorAction Stop |
    Where-Object { $_.RemoteAddress -notin @('127.0.0.1', '::1', '0.0.0.0') -and $_.RemoteAddress -notlike '192.168.*' -and $_.RemoteAddress -notlike '10.*' } |
    ForEach-Object {
      $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
      [pscustomobject]@{ Key = "$($p.ProcessName) -> $($_.RemoteAddress):$($_.RemotePort)"; Action = "$($_.OwningProcess)" }
    }
}

$pf = Safe {
  foreach ($root in @('C:\Program Files', 'C:\Program Files (x86)')) {
    if (Test-Path $root) {
      Get-ChildItem -LiteralPath $root -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $exe = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object).Count
        [pscustomobject]@{ Key = $_.FullName; Action = "files=$exe" }
      }
    }
  }
}

$snap = [pscustomobject]@{
  taken   = (Get-Date -Format o)
  machine = $env:COMPUTERNAME
  user    = $env:USERNAME
  tasks   = @($tasks | Where-Object { $_ })
  services= @($services | Where-Object { $_ })
  run     = @($run | Where-Object { $_ })
  startup = @($startup | Where-Object { $_ })
  wmi     = @($wmi | Where-Object { $_ })
  listen  = @($listen | Where-Object { $_ })
  remote  = @($remote | Where-Object { $_ })
  programfiles = @($pf | Where-Object { $_ })
}

$snap | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Out -Encoding UTF8
"snapshot written: $Out"
"tasks=$($snap.tasks.Count) services=$($snap.services.Count) run=$($snap.run.Count) startup=$($snap.startup.Count) wmi=$($snap.wmi.Count) listen=$($snap.listen.Count) remote=$($snap.remote.Count)"
