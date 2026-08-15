$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dataRoot = Join-Path $projectRoot '.dkn'
$logRoot = Join-Path $dataRoot 'logs'
$modelScript = Join-Path $PSScriptRoot 'start-model.ps1'
$serverEntry = Join-Path $projectRoot 'dist\server\server.js'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
Set-Location -LiteralPath $projectRoot

function Test-HttpEndpoint([string]$Uri) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Wait-ForEndpoint([string]$Uri, [string]$Name, [int]$TimeoutSeconds = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpEndpoint $Uri) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name did not become ready within $TimeoutSeconds seconds."
}

if (Test-HttpEndpoint 'http://127.0.0.1:8080/health') {
  Write-Host '[services] GPU model server is already running.'
} else {
  Write-Host '[services] Starting the GPU model server...'
  $modelArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$modelScript`""
  Start-Process -FilePath 'powershell.exe' -ArgumentList $modelArguments -WorkingDirectory $projectRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot 'model.stdout.log') -RedirectStandardError (Join-Path $logRoot 'model.stderr.log') | Out-Null
  Wait-ForEndpoint 'http://127.0.0.1:8080/health' 'GPU model server'
  Write-Host '[services] GPU model server is ready.'
}

if (Test-HttpEndpoint 'http://127.0.0.1:4174/api/status') {
  Write-Host '[services] Knowledge application is already running.'
} else {
  if (-not (Test-Path -LiteralPath $serverEntry) -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\web\index.html'))) {
    Write-Host '[services] Production build is missing; building it now...'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
  }
  Write-Host '[services] Starting the knowledge application...'
  $nodeArguments = "`"$serverEntry`""
  Start-Process -FilePath 'node.exe' -ArgumentList $nodeArguments -WorkingDirectory $projectRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot 'app.stdout.log') -RedirectStandardError (Join-Path $logRoot 'app.stderr.log') | Out-Null
  Wait-ForEndpoint 'http://127.0.0.1:4174/api/status' 'Knowledge application' 30
  Write-Host '[services] Knowledge application is ready.'
}

Write-Host '[workflow] Synchronizing Telegram...'
& npm.cmd run dev -- telegram sync
if ($LASTEXITCODE -ne 0) { throw 'Telegram synchronization failed.' }

Write-Host '[workflow] Enriching notes and rebuilding graph connections...'
& npm.cmd run dev -- process --provider openai
if ($LASTEXITCODE -ne 0) { throw 'Note enrichment failed.' }

Write-Host '[workflow] Final status:'
& npm.cmd run dev -- status
if ($LASTEXITCODE -ne 0) { throw 'Status check failed.' }

Write-Host '[workflow] Complete. The graph refreshes automatically at http://127.0.0.1:4174/'
