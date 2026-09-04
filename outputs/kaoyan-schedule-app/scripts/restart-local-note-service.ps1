$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$notesRoot = if ($env:KAOYAN_NOTES_ROOT) {
  [string]$env:KAOYAN_NOTES_ROOT
} else {
  Join-Path ([Environment]::GetFolderPath('Desktop')) ([string](-join @([char]0x7b14, [char]0x8bb0)))
}

# Never replace a healthy user-owned service with a sandboxed/read-only one.
# Validate write access before stopping the existing listener so a failed
# administrative or automation launch leaves the current service untouched.
if (Test-Path -LiteralPath $notesRoot) {
  $writeProbe = Join-Path $notesRoot ".kaoyan-service-write-probe-$PID.tmp"
  try {
    [System.IO.File]::WriteAllBytes($writeProbe, [byte[]]@())
  } catch {
    throw "Cannot restart note service: current process cannot write to $notesRoot. Run the restart with the normal Windows user account."
  } finally {
    if (Test-Path -LiteralPath $writeProbe) { Remove-Item -LiteralPath $writeProbe -Force }
  }
}

$listenerLines = netstat -ano -p tcp | Select-String -Pattern '^\s*TCP\s+\S+:5174\s+\S+\s+LISTENING\s+\d+\s*$'
$listenerPids = @($listenerLines | ForEach-Object {
  $parts = ($_.Line.Trim() -split '\s+')
  [int]$parts[-1]
} | Sort-Object -Unique)

foreach ($listenerPid in $listenerPids) {
  $process = Get-Process -Id $listenerPid -ErrorAction Stop
  if ($process.ProcessName -ne 'node') {
    throw "Port 5174 is owned by unexpected process $($process.ProcessName) ($listenerPid)"
  }
  Stop-Process -Id $listenerPid -Force
}

$deadline = (Get-Date).AddSeconds(10)
do {
  $stillListening = netstat -ano -p tcp | Select-String -Pattern '^\s*TCP\s+\S+:5174\s+\S+\s+LISTENING\s+\d+\s*$'
  if (-not $stillListening) { break }
  Start-Sleep -Milliseconds 100
} while ((Get-Date) -lt $deadline)
if ($stillListening) { throw 'Port 5174 did not stop within 10 seconds' }

$serverPath = Join-Path $projectRoot 'scripts\note-server.cjs'
$started = Start-Process -FilePath $nodeCommand.Source -ArgumentList @($serverPath) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
$healthDeadline = (Get-Date).AddSeconds(20)
do {
  try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5174/health' -TimeoutSec 2
    if ($health.StatusCode -eq 200) {
      [pscustomobject]@{ Ok = $true; ProcessId = $started.Id; Health = $health.StatusCode }
      exit 0
    }
  } catch {
    Start-Sleep -Milliseconds 200
  }
} while ((Get-Date) -lt $healthDeadline)

throw 'The note service did not become healthy within 20 seconds'
