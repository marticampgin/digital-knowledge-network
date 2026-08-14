$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$server = Join-Path $projectRoot '.dkn\tools\llama.cpp\llama-server.exe'
$model = Join-Path $projectRoot '.dkn\models\lfm2.5-2.6b\LFM2.5-2.6B-Q4_K_M.gguf'

if (-not (Test-Path -LiteralPath $server) -or -not (Test-Path -LiteralPath $model)) {
  throw 'Local model runtime is missing. Run npm run models:setup first.'
}

Write-Host 'Starting LFM2.5-2.6B locally at http://127.0.0.1:8080/v1'
Write-Host 'This terminal remains attached to the model server. Press Ctrl+C to stop it.'
& $server --model $model --host 127.0.0.1 --port 8080 --ctx-size 8192 --threads 6 --parallel 1 --reasoning-budget 96 --no-webui
