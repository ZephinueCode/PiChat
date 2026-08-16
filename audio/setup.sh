#!/usr/bin/env bash

set -Eeuo pipefail

show_help() {
  cat <<'EOF'
Set up PiChat's optional local TTS and ASR service on Linux.

Usage:
  ./audio/setup.sh [options]

Options:
  --cpu-only             Install the CPU build of PyTorch even when an NVIDIA GPU is available.
  --skip-models          Install dependencies without downloading model weights.
  --skip-system-packages Do not install PortAudio or Python build packages with the system package manager.
  --training             Install training utilities and download the Base model and 12Hz tokenizer.
  -h, --help             Show this help message.

Environment:
  PICHAT_PYTHON          Python executable to use (default: python3).
EOF
}

CPU_ONLY=false
SKIP_MODELS=false
SKIP_SYSTEM_PACKAGES=false
TRAINING=false

while (($#)); do
  case "$1" in
    --cpu-only)
      CPU_ONLY=true
      ;;
    --skip-models)
      SKIP_MODELS=true
      ;;
    --skip-system-packages)
      SKIP_SYSTEM_PACKAGES=true
      ;;
    --training)
      TRAINING=true
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      show_help >&2
      exit 2
      ;;
  esac
  shift
done

trap 'printf "PiChat audio setup failed at line %s.\n" "$LINENO" >&2' ERR

AUDIO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
VENV_ROOT="$AUDIO_ROOT/.venv"
VENV_PYTHON="$VENV_ROOT/bin/python"
MODELSCOPE="$VENV_ROOT/bin/modelscope"
PIP_MIRROR="https://pypi.tuna.tsinghua.edu.cn/simple"
PYTHON_COMMAND="${PICHAT_PYTHON:-python3}"

if ! command -v "$PYTHON_COMMAND" >/dev/null 2>&1; then
  printf '%s was not found. Install Python 3 or set PICHAT_PYTHON to its executable.\n' "$PYTHON_COMMAND" >&2
  exit 1
fi

"$PYTHON_COMMAND" - <<'PY'
import sys

if sys.version_info < (3, 10):
    raise SystemExit("PiChat audio requires Python 3.10 or newer.")
PY

run_as_root() {
  if ((EUID == 0)); then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    printf 'Root access is required to install Linux audio dependencies. Install PortAudio manually or rerun with --skip-system-packages.\n' >&2
    return 1
  fi
}

has_portaudio() {
  "$PYTHON_COMMAND" - <<'PY' >/dev/null 2>&1
import ctypes.util
import sys

sys.exit(0 if ctypes.util.find_library("portaudio") else 1)
PY
}

has_venv_support() {
  "$PYTHON_COMMAND" - <<'PY' >/dev/null 2>&1
import ensurepip
import venv
PY
}

install_system_packages() {
  if $SKIP_SYSTEM_PACKAGES || { has_portaudio && has_venv_support; }; then
    return
  fi

  printf 'Installing PortAudio and Python build dependencies...\n'
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y python3-venv python3-dev build-essential portaudio19-dev libsndfile1
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y python3-devel gcc gcc-c++ portaudio-devel libsndfile
  elif command -v pacman >/dev/null 2>&1; then
    run_as_root pacman -S --needed --noconfirm python base-devel portaudio libsndfile
  elif command -v zypper >/dev/null 2>&1; then
    run_as_root zypper --non-interactive install python3-devel gcc gcc-c++ portaudio-devel libsndfile1
  else
    cat >&2 <<'EOF'
No supported package manager was found. Install PortAudio and the Python venv/build packages for your distribution, then rerun with --skip-system-packages.
EOF
    exit 1
  fi
}

if [[ -d "$VENV_ROOT" && ! -x "$VENV_PYTHON" ]]; then
  cat >&2 <<EOF
$VENV_ROOT already exists but is not a Linux virtual environment.
Move or remove it before running this script. Do not share one audio/.venv directory between Windows and Linux.
EOF
  exit 1
fi

install_system_packages

if [[ ! -x "$VENV_PYTHON" ]]; then
  "$PYTHON_COMMAND" -m venv "$VENV_ROOT"
fi

"$VENV_PYTHON" -m pip install --upgrade pip wheel 'setuptools<82' -i "$PIP_MIRROR"

has_nvidia_gpu() {
  command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1
}

if $CPU_ONLY || ! has_nvidia_gpu; then
  printf 'Installing the CPU build of PyTorch...\n'
  "$VENV_PYTHON" -m pip install 'torch==2.11.0+cpu' 'torchaudio==2.11.0+cpu' \
    --index-url 'https://download.pytorch.org/whl/cpu'
else
  printf 'NVIDIA GPU detected; installing the CUDA 12.8 build of PyTorch...\n'
  "$VENV_PYTHON" -m pip install 'torch==2.11.0+cu128' 'torchaudio==2.11.0+cu128' \
    --index-url 'https://download.pytorch.org/whl/cu128'
fi

"$VENV_PYTHON" -m pip install -r "$AUDIO_ROOT/requirements.txt" -i "$PIP_MIRROR"
if $TRAINING; then
  "$VENV_PYTHON" -m pip install -r "$AUDIO_ROOT/training/requirements.txt" -i "$PIP_MIRROR"
fi

if [[ ! -f "$AUDIO_ROOT/config.local.json" ]]; then
  cp -- "$AUDIO_ROOT/config.example.json" "$AUDIO_ROOT/config.local.json"
fi

if ! $SKIP_MODELS; then
  mkdir -p -- "$AUDIO_ROOT/models"
  "$MODELSCOPE" download --model 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice' \
    --local_dir "$AUDIO_ROOT/models/Qwen3-TTS-12Hz-0.6B-CustomVoice"
  "$MODELSCOPE" download --model 'iic/SenseVoiceSmall' \
    --local_dir "$AUDIO_ROOT/models/SenseVoiceSmall"
  if $TRAINING; then
    "$MODELSCOPE" download --model 'Qwen/Qwen3-TTS-12Hz-0.6B-Base' \
      --local_dir "$AUDIO_ROOT/models/Qwen3-TTS-12Hz-0.6B-Base"
    "$MODELSCOPE" download --model 'Qwen/Qwen3-TTS-Tokenizer-12Hz' \
      --local_dir "$AUDIO_ROOT/models/Qwen3-TTS-Tokenizer-12Hz"
    "$MODELSCOPE" download --model 'iic/speech_campplus_sv_zh-cn_16k-common' \
      --local_dir "$AUDIO_ROOT/models/CAMPPlus"
  fi
fi

"$VENV_PYTHON" "$AUDIO_ROOT/doctor.py"

printf 'PiChat audio setup is complete. Restart Pi or run /reload, then use /tts, /mic, /call, or /voice.\n'
