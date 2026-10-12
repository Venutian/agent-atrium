param([switch]$Headless)
# Agent Atrium launcher: rebuild only when the code changed, restart the server only when it
# has to, then open the page. Run hidden by launch.vbs (the desktop shortcut) and at login.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$npm = (Get-Command npm.cmd).Source
$node = (Get-Command node.exe).Source
$serverFile = Join-Path $projectRoot 'server\serve.mjs'
$dataDir = Join-Path $projectRoot 'data'
$builtPage = Join-Path $projectRoot 'dist\index.html'
$serverStamp = Join-Path $dataDir 'server-started.txt'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$mutex = New-Object System.Threading.Mutex($false, 'Local\AgentAtriumLauncher')
if (-not $mutex.WaitOne(0)) { exit 0 }

# The newest modification time under any of these paths, or 0 when none exist.
function Newest([string[]]$paths) {
  $newest = [datetime]::MinValue
  foreach ($p in $paths) {
    $full = Join-Path $projectRoot $p
    if (-not (Test-Path -LiteralPath $full)) { continue }
    $item = Get-Item -LiteralPath $full
    $files = if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $full -Recurse -File } else { @($item) }
    foreach ($f in $files) { if ($f.LastWriteTimeUtc -gt $newest) { $newest = $f.LastWriteTimeUtc } }
  }
  return $newest
}

try {
  Set-Location -LiteralPath $projectRoot
  # A failure from an earlier run must not be what the next error message points at.
  Remove-Item -LiteralPath (Join-Path $dataDir 'launcher-error.log') -ErrorAction SilentlyContinue
  $url = 'http://localhost:5274'
  $healthUrl = 'http://127.0.0.1:5274/api/harnesses'

  # Rebuild only when something the page is built from is newer than the last build — after a
  # git pull, say. Built before anything is stopped, so a failed build leaves the running copy up.
  $pageSources = @('src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.js')
  $built = $false
  if (-not (Test-Path -LiteralPath $builtPage) -or (Newest $pageSources) -gt (Get-Item -LiteralPath $builtPage).LastWriteTimeUtc) {
    # Windows PowerShell treats native stderr warnings as errors under Stop.
    $ErrorActionPreference = 'Continue'
    & $npm run build *> (Join-Path $dataDir 'build.log')
    $buildExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($buildExitCode -ne 0) { throw 'Build failed. See data\build.log.' }
    $built = $true
  }

  $running = $false
  try { $running = (Invoke-WebRequest $healthUrl -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}

  # The server holds its code in memory, so it is restarted when that code changed since it
  # started. A fresh page alone does not need a restart: the server reads dist/ on each request.
  $serverChanged = -not (Test-Path -LiteralPath $serverStamp) -or
    (Newest @('server', 'package.json')) -gt (Get-Item -LiteralPath $serverStamp).LastWriteTimeUtc
  if ($running -and $serverChanged) {
    # Only stop instances that name this checkout's server script.
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
      $_.CommandLine -and $_.CommandLine.Contains($serverFile)
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Milliseconds 400
    $running = $false
  }

  if (-not $running) {
    $env:AGENT_ATRIUM_LOG_DIR = $dataDir
    Start-Process -FilePath $node -ArgumentList @('"' + $serverFile + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden
    Set-Content -LiteralPath $serverStamp -Value (Get-Date -Format o) -Encoding utf8
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      try { if ((Invoke-WebRequest $healthUrl -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200) { $running = $true; break } } catch {}
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $running) { throw 'Server did not start. See data\server-error.log.' }
  if (-not $Headless) { Start-Process $url }
} catch {
  $_ | Out-File -LiteralPath (Join-Path $dataDir 'launcher-error.log')
  exit 1
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
