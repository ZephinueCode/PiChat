from __future__ import annotations

import gc
from typing import Any


LANGUAGES = {
    "auto": "Auto",
    "zh": "Chinese",
    "en": "English",
    "chinese": "Chinese",
    "english": "English",
}


class QwenTTSProvider:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.model = None
        self.model_path: str | None = None
        self.clone_prompts: dict[str, Any] = {}
        self.device = "cpu"

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def load(self, model_path: str | None = None) -> None:
        selected_model = model_path or self.config["model"]
        if self.model is not None and self.model_path == selected_model:
            return
        if self.model is not None:
            self.unload()
        import torch
        from qwen_tts import Qwen3TTSModel

        requested = str(self.config.get("device", "auto")).lower()
        self.device = "cuda:0" if requested == "auto" and torch.cuda.is_available() else requested
        if self.device == "auto":
            self.device = "cpu"
        dtype_name = str(self.config.get("dtype", "bfloat16"))
        dtype = getattr(torch, dtype_name, torch.bfloat16)
        if self.device == "cpu" and dtype in (torch.float16, torch.bfloat16):
            dtype = torch.float32
        self.model = Qwen3TTSModel.from_pretrained(
            selected_model,
            device_map=self.device,
            dtype=dtype,
            attn_implementation=self.config.get("attention", "sdpa"),
        )
        self.model_path = selected_model

    def unload(self) -> None:
        if self.model is None:
            return
        self.model = None
        self.model_path = None
        self.clone_prompts.clear()
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def synthesize(
        self,
        text: str,
        profile_name: str | None = None,
        language: str | None = None,
    ):
        profiles = self.config.get("profiles", {})
        selected_name = profile_name or self.config.get("defaultProfile", "default")
        profile = profiles.get(selected_name)
        if profile is None:
            available = ", ".join(sorted(profiles)) or "default"
            raise ValueError(f"Unknown voice profile '{selected_name}'. Available profiles: {available}")
        self.load(profile.get("model", self.config["model"]))
        requested_language = language or profile.get("language", "Auto")
        normalized_language = LANGUAGES.get(str(requested_language).lower(), requested_language)
        mode = str(profile.get("mode", "customVoice")).lower()
        if mode == "customvoice":
            kwargs = {
                "text": text,
                "language": normalized_language,
                "speaker": profile.get("speaker", "Serena"),
            }
            if profile.get("instruct"):
                kwargs["instruct"] = profile["instruct"]
            wavs, sample_rate = self.model.generate_custom_voice(**kwargs)
        elif mode == "voiceclone":
            ref_audio = profile.get("refAudio")
            if not ref_audio:
                raise ValueError(f"Voice-clone profile '{selected_name}' requires refAudio.")
            prompt = self.clone_prompts.get(selected_name)
            if prompt is None:
                prompt = self.model.create_voice_clone_prompt(
                    ref_audio=ref_audio,
                    ref_text=profile.get("refText"),
                    x_vector_only_mode=bool(profile.get("xVectorOnly", False)),
                )
                self.clone_prompts[selected_name] = prompt
            wavs, sample_rate = self.model.generate_voice_clone(
                text=text,
                language=normalized_language,
                voice_clone_prompt=prompt,
            )
        else:
            raise ValueError(f"Unsupported TTS mode '{mode}' for profile '{selected_name}'.")
        return wavs[0], sample_rate, selected_name
