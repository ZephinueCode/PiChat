param(
  [switch]$SkipModels,
  [switch]$CpuOnly,
  [switch]$Training
)

$ErrorActionPreference = "Stop"
$AudioRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvRoot = Join-Path $AudioRoot ".venv"
$Python = Join-Path $VenvRoot "Scripts\python.exe"
$ModelScope = Join-Path $VenvRoot "Scripts\modelscope.exe"
$Mirror = "https://pypi.tuna.tsinghua.edu.cn/simple"

if (-not (Test-Path $Python)) {
  python -m venv $VenvRoot
}

& $Python -m pip install --upgrade pip wheel "setuptools<82" -i $Mirror
if (-not $CpuOnly -and (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
  # CUDA wheels are not published on standard PyPI mirrors. All other Python
  # packages continue to use the Tsinghua mirror below.
  & $Python -m pip install "torch==2.11.0+cu128" "torchaudio==2.11.0+cu128" --index-url "https://download.pytorch.org/whl/cu128"
}
& $Python -m pip install -r (Join-Path $AudioRoot "requirements.txt") -i $Mirror
if ($Training) {
  & $Python -m pip install -r (Join-Path $AudioRoot "training\requirements.txt") -i $Mirror
}

$LocalConfig = Join-Path $AudioRoot "config.local.json"
if (-not (Test-Path $LocalConfig)) {
  Copy-Item (Join-Path $AudioRoot "config.example.json") $LocalConfig
}

if (-not $SkipModels) {
  $Models = Join-Path $AudioRoot "models"
  New-Item -ItemType Directory -Force $Models | Out-Null
  & $ModelScope download --model "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice" --local_dir (Join-Path $Models "Qwen3-TTS-12Hz-0.6B-CustomVoice")
  & $ModelScope download --model "iic/SenseVoiceSmall" --local_dir (Join-Path $Models "SenseVoiceSmall")
  if ($Training) {
    & $ModelScope download --model "Qwen/Qwen3-TTS-12Hz-0.6B-Base" --local_dir (Join-Path $Models "Qwen3-TTS-12Hz-0.6B-Base")
    & $ModelScope download --model "Qwen/Qwen3-TTS-Tokenizer-12Hz" --local_dir (Join-Path $Models "Qwen3-TTS-Tokenizer-12Hz")
    & $ModelScope download --model "iic/speech_campplus_sv_zh-cn_16k-common" --local_dir (Join-Path $Models "CAMPPlus")
  }
}

& $Python (Join-Path $AudioRoot "doctor.py")

Write-Host "PiChat audio setup is complete. Restart Pi or run /reload, then use /tts, /mic, /call, or /voice."
