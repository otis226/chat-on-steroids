param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'status', 'stop')]
  [string]$Command = 'status',
  [switch]$Json,
  [string]$AppPath = '',
  [string]$UserData = ''
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($AppPath)) {
  $AppPath = Join-Path $ScriptRoot 'Chat On Steroids.exe'
}
if ([string]::IsNullOrWhiteSpace($UserData)) {
  $UserData = Join-Path $env:APPDATA 'chat-on-steroids'
}
$StatePath = Join-Path $UserData 'state\core-runtime.json'

function Read-CoreState {
  if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
  try { return Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { return $null }
}

function Test-CoreProcess($state) {
  if ($null -eq $state -or $null -eq $state.pid) { return $false }
  $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.ProcessName -ne 'Chat On Steroids') { return $false }
  try {
    if ($process.Path -and (Test-Path -LiteralPath $AppPath)) {
      return [string]::Equals(
        [IO.Path]::GetFullPath($process.Path),
        [IO.Path]::GetFullPath($AppPath),
        [StringComparison]::OrdinalIgnoreCase
      )
    }
  } catch {}
  return $true
}

function Get-CoreView {
  $state = Read-CoreState
  $alive = Test-CoreProcess $state
  $status = if ($null -eq $state -or $state.phase -eq 'stopped') {
    'stopped'
  } elseif ($alive) {
    'running'
  } else {
    'stale'
  }
  [pscustomobject]@{
    status = $status
    mode = if ($null -eq $state) { $null } else { $state.mode }
    phase = if ($null -eq $state) { $null } else { $state.phase }
    pid = if ($null -eq $state) { $null } else { $state.pid }
    version = if ($null -eq $state) { $null } else { $state.appVersion }
    connection = if ($null -eq $state) { $null } else { $state.connection.state }
    detail = if ($null -eq $state) { $null } else { $state.connection.detail }
    bridge = if ($null -eq $state) { $false } else { [bool]$state.bridge.running }
    bridgePort = if ($null -eq $state) { $null } else { $state.bridge.port }
  }
}

function Write-CoreView($view) {
  if ($Json) {
    $view | ConvertTo-Json -Compress
    return
  }
  $parts = @($view.status)
  if ($view.mode) { $parts += $view.mode }
  if ($view.pid) { $parts += "pid=$($view.pid)" }
  if ($view.connection) { $parts += "connection=$($view.connection)" }
  if ($view.bridge) { $parts += "bridge=$($view.bridgePort)" }
  Write-Output ($parts -join ' ')
}

if ($Command -eq 'status') {
  Write-CoreView (Get-CoreView)
  exit 0
}

if (-not (Test-Path -LiteralPath $AppPath)) {
  throw "Chat On Steroids executable was not found at $AppPath"
}

if ($Command -eq 'start') {
  $before = Get-CoreView
  if ($before.status -eq 'running') {
    Write-CoreView $before
    exit 0
  }
  Start-Process -FilePath $AppPath -ArgumentList '--headless' -WindowStyle Hidden | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    $view = Get-CoreView
    if ($view.status -eq 'running' -and $view.mode -eq 'headless' -and $view.phase -eq 'ready') {
      Write-CoreView $view
      exit 0
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  Write-CoreView (Get-CoreView)
  throw 'Headless Core did not become ready within 20 seconds.'
}

$before = Get-CoreView
if ($before.status -ne 'running') {
  Write-CoreView $before
  exit 0
}

Start-Process -FilePath $AppPath -ArgumentList '--core-stop' -WindowStyle Hidden -Wait | Out-Null
$deadline = [DateTime]::UtcNow.AddSeconds(50)
do {
  Start-Sleep -Milliseconds 250
  $view = Get-CoreView
  if ($view.status -eq 'stopped' -or $view.status -eq 'stale') {
    Write-CoreView $view
    exit 0
  }
} while ([DateTime]::UtcNow -lt $deadline)
Write-CoreView (Get-CoreView)
throw 'Core did not stop within 50 seconds.'
