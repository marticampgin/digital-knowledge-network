$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dataRoot = Join-Path $projectRoot '.dkn'
$modelsRoot = Join-Path $dataRoot 'models'
$toolsRoot = Join-Path $dataRoot 'tools'
New-Item -ItemType Directory -Force -Path $modelsRoot, $toolsRoot | Out-Null

$hfExe = Join-Path $env:USERPROFILE '.local\bin\hf.exe'
if (-not (Test-Path -LiteralPath $hfExe)) {
  Write-Host 'Installing the official Hugging Face CLI...'
  powershell -ExecutionPolicy ByPass -c "irm https://hf.co/cli/install.ps1 | iex"
}
if (-not (Test-Path -LiteralPath $hfExe)) { throw "Hugging Face CLI was not installed at $hfExe" }

Write-Host 'Downloading LFM2.5-2.6B Q4_K_M (about 1.7 GB)...'
& $hfExe download LiquidAI/LFM2.5-2.6B-GGUF LFM2.5-2.6B-Q4_K_M.gguf --local-dir (Join-Path $modelsRoot 'lfm2.5-2.6b')

Write-Host 'Downloading Whisper base.en (about 148 MB)...'
& $hfExe download ggerganov/whisper.cpp ggml-base.en.bin --local-dir (Join-Path $modelsRoot 'whisper')

$llamaVersion = 'b10428'
$llamaDir = Join-Path $toolsRoot 'llama.cpp'
if (-not (Test-Path -LiteralPath (Join-Path $llamaDir 'llama-server.exe'))) {
  $llamaZip = Join-Path $toolsRoot 'llama.zip'
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/ggml-org/llama.cpp/releases/download/$llamaVersion/llama-$llamaVersion-bin-win-cpu-x64.zip" -OutFile $llamaZip
  New-Item -ItemType Directory -Force -Path $llamaDir | Out-Null
  Expand-Archive -LiteralPath $llamaZip -DestinationPath $llamaDir -Force
  Remove-Item -LiteralPath $llamaZip
}

$whisperVersion = 'v1.9.2'
$whisperDir = Join-Path $toolsRoot 'whisper.cpp'
if (-not (Test-Path -LiteralPath (Join-Path $whisperDir 'Release\whisper-cli.exe'))) {
  $whisperZip = Join-Path $toolsRoot 'whisper.zip'
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/ggml-org/whisper.cpp/releases/download/$whisperVersion/whisper-bin-x64.zip" -OutFile $whisperZip
  New-Item -ItemType Directory -Force -Path $whisperDir | Out-Null
  Expand-Archive -LiteralPath $whisperZip -DestinationPath $whisperDir -Force
  Remove-Item -LiteralPath $whisperZip
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing FFmpeg Essentials for M4A/AAC conversion...'
  winget install --id Gyan.FFmpeg.Essentials --exact --silent --accept-source-agreements --accept-package-agreements
}

Write-Host 'Local model setup complete.'
Write-Host "Language model: $(Join-Path $modelsRoot 'lfm2.5-2.6b\LFM2.5-2.6B-Q4_K_M.gguf')"
Write-Host "Speech model:   $(Join-Path $modelsRoot 'whisper\ggml-base.en.bin')"

