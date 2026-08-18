param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Work,
  [switch]$Refresh,
  [string]$Out
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logRoot = Join-Path $projectRoot '.dkn\logs'
$modelScript = Join-Path $PSScriptRoot 'start-model.ps1'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
Set-Location -LiteralPath $projectRoot

function Test-ModelEndpoint {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

if (-not (Test-ModelEndpoint)) {
  Write-Host '[summary] Starting the GPU model server...'
  $modelArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$modelScript`""
  Start-Process -FilePath 'powershell.exe' -ArgumentList $modelArguments -WorkingDirectory $projectRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot 'model.stdout.log') -RedirectStandardError (Join-Path $logRoot 'model.stderr.log') | Out-Null
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline -and -not (Test-ModelEndpoint)) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-ModelEndpoint)) { throw 'GPU model server did not become ready within 90 seconds.' }
}

$cliArguments = @('run', 'dev', '--', 'summarize', '--provider', 'openai', '--work', $Work)
if ($Refresh) { $cliArguments += '--refresh' }
if ($Out) { $cliArguments += @('--out', $Out) }
& npm.cmd @cliArguments
if ($LASTEXITCODE -ne 0) { throw 'Work summary generation failed.' }
