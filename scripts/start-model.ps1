$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$server = Join-Path $projectRoot '.dkn\tools\llama.cpp\llama-server.exe'
$model = Join-Path $projectRoot '.dkn\models\lfm2.5-2.6b\LFM2.5-2.6B-Q4_K_M.gguf'

if (-not (Test-Path -LiteralPath $server) -or -not (Test-Path -LiteralPath $model)) {
  throw 'Local model runtime is missing. Run npm run models:setup first.'
}
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $server) 'ggml-vulkan.dll'))) {
  throw 'GPU runtime is missing. Run npm run models:setup to install the llama.cpp Vulkan build.'
}
$existingListener = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingListener) {
  $existingProcess = Get-Process -Id $existingListener.OwningProcess -ErrorAction SilentlyContinue
  if ($existingProcess -and $existingProcess.ProcessName -eq 'llama-server') {
    Write-Host "The model server is already running on port 8080 (PID $($existingProcess.Id))."
    exit 0
  }
  throw "Port 8080 is already used by PID $($existingListener.OwningProcess). Stop that process or configure another port."
}

$devices = (& $server --list-devices 2>&1 | Out-String).Trim()
if (-not $devices -or $devices -match 'No devices') {
  throw 'The Vulkan runtime did not detect a GPU. Update the graphics driver, then retry.'
}
$device = if ($env:DKN_LLM_DEVICE) { $env:DKN_LLM_DEVICE } else { 'Vulkan0' }
if ($devices -notmatch "(?m)^\s*$([regex]::Escape($device)):") {
  throw "Configured GPU '$device' was not detected. Available devices:`n$devices"
}

Write-Host $devices
Write-Host "Starting LFM2.5-2.6B on $device with full GPU offload at http://127.0.0.1:8080/v1"
Write-Host 'This terminal remains attached to the model server. Press Ctrl+C to stop it.'
& $server --model $model --host 127.0.0.1 --port 8080 --ctx-size 8192 --threads 6 --parallel 1 --device $device --gpu-layers 999 --fit on --flash-attn auto --reasoning-budget 96 --no-webui
