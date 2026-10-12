param(
  # Leave out the login entry: the shortcuts still start it on demand.
  [switch]$NoStartup,
  # Take every shortcut away again.
  [switch]$Remove
)
# Puts Agent Atrium on the Desktop and in the Start menu, and starts it in the background at
# login. Each shortcut runs launch.vbs, which starts the server hidden — no console window.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$startup = [Environment]::GetFolderPath('Startup')

$names = @{
  desktop = Join-Path $desktop 'Agent Atrium.lnk'
  menu = Join-Path $programs 'Agent Atrium.lnk'
  login = Join-Path $startup 'Agent Atrium.lnk'
}
if ($Remove) {
  foreach ($file in $names.Values) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file } }
  Write-Output 'Agent Atrium shortcuts removed.'
  exit
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcher = Join-Path $projectRoot 'launch.vbs'
foreach ($file in @($names.desktop, $names.menu)) {
  $s = $shell.CreateShortcut($file)
  $s.TargetPath = $wscript
  $s.Arguments = '"' + $launcher + '"'
  $s.WorkingDirectory = $projectRoot
  $s.Description = 'Open Agent Atrium'
  $s.Save()
}

if ($NoStartup) {
  if (Test-Path -LiteralPath $names.login) { Remove-Item -LiteralPath $names.login }
} else {
  $s = $shell.CreateShortcut($names.login)
  $s.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'launch.ps1') + '" -Headless'
  $s.WorkingDirectory = $projectRoot
  $s.WindowStyle = 7
  $s.Description = 'Start Agent Atrium in the background at login'
  $s.Save()
}
Write-Output 'Agent Atrium is on the Desktop and in the Start menu.'
if (-not $NoStartup) { Write-Output 'It also starts in the background when you log in.' }
