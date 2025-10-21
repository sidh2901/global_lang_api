"""Core translation pipeline used by the web API."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Dict, Optional, Tuple, List

import logging
from pathlib import Path
from typing import Dict, Optional, Tuple, List

import ctranslate2
import numpy as np
import pyttsx3
import soundfile as sf
from faster_whisper import WhisperModel
from transformers import AutoTokenizer

from .config import (
    TRANSLATION_MODEL_DIR,
    TRANSLATION_MODEL_ID,
    WHISPER_MODEL,
    XTTS_DEFAULT_SPEAKER_DIR,
)
from .languages import DEFAULT_SOURCE_LANG, LANGUAGE_CONFIG
from .xtts_adapter import get_xtts_adapter

try:
    from kokoro import KPipeline
except ImportError:  # pragma: no cover - optional dependency
    KPipeline = None  # type: ignore[assignment]


def _ensure_translation_model() -> Path:
    """Ensure a converted CTranslate2 checkpoint is available locally."""
    target_dir = Path(TRANSLATION_MODEL_DIR)
    model_file = target_dir / "model.bin"
    if model_file.exists():
        return target_dir
    raise RuntimeError(
        f"CTranslate2 model not found in {target_dir}. "
        "Run `python download_models.py --translation-model "
        f"{TRANSLATION_MODEL_ID} --output-dir {target_dir}` before starting the service."
    )


def _device_for_translation() -> str:
    try:
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception:
        pass
    return "cpu"


class TranslationPipeline:
    """Wraps Whisper, NLLB (via CTranslate2) and Kokoro for reuse."""

    def __init__(self, target_language: str) -> None:
        if target_language not in LANGUAGE_CONFIG:
            raise ValueError(f"Unsupported language: {target_language}")

        self.lang_key = target_language
        self.logger = logging.getLogger(__name__)
        self.lang_config = LANGUAGE_CONFIG[target_language]
        self.model_dir = _ensure_translation_model()
        self.tokenizer = AutoTokenizer.from_pretrained(TRANSLATION_MODEL_ID, use_fast=False)
        self.source_lang = self.lang_config.get("source_lang_code", DEFAULT_SOURCE_LANG)
        self.target_token = self._resolve_target_token(self.lang_config["translation_token"], self.tokenizer)
        self.device = _device_for_translation()
        self.xtts_language = self.lang_config.get("xtts_language")
        self.xtts_reference: Optional[Path] = None
        configured_reference = self.lang_config.get("xtts_reference")
        if configured_reference:
            candidate = Path(configured_reference).expanduser().resolve()
            if candidate.exists():
                self.xtts_reference = candidate
        elif XTTS_DEFAULT_SPEAKER_DIR and self.xtts_language:
            candidate = (XTTS_DEFAULT_SPEAKER_DIR / f"{self.xtts_language}.wav").resolve()
            if candidate.exists():
                self.xtts_reference = candidate

        self.tokenizer.src_lang = self.source_lang
        if hasattr(self.tokenizer, "tgt_lang"):
            self.tokenizer.tgt_lang = self.target_token

        self.translator = ctranslate2.Translator(
            str(self.model_dir),
            device=self.device,
            compute_type="int8",
        )
        self.whisper = WhisperModel(
            WHISPER_MODEL,
            device=self.device,
            compute_type="int8",
        )
        self.kokoro: Optional[KPipeline] = None
        self.kokoro_voice = self.lang_config.get("kokoro_voice", "af_heart")
        self.kokoro_sample_rate = 24000
        self.pyttsx3_voice_hint = self.lang_config.get("pyttsx3_voice_hint")
        self.pyttsx3_rate = self.lang_config.get("pyttsx3_rate", 190)
        self.logger = logging.getLogger(__name__)
        if KPipeline is not None:
            try:
                self.kokoro = KPipeline(lang_code=self.lang_config.get("kokoro_lang", "en"))
            except Exception:
                self.kokoro = None

    @staticmethod
    def _resolve_target_token(token_code: str, tokenizer) -> str:
        if hasattr(tokenizer, "lang_code_to_id") and token_code in tokenizer.lang_code_to_id:
            lang_id = tokenizer.lang_code_to_id[token_code]
            return tokenizer.convert_ids_to_tokens([lang_id])[0]
        if hasattr(tokenizer, "lang_code_to_token") and token_code in tokenizer.lang_code_to_token:
            return tokenizer.lang_code_to_token[token_code]
        return token_code

    def transcribe(self, audio_file: Path, language_hint: Optional[str] = None) -> str:
        segments, _ = self.whisper.transcribe(
            str(audio_file),
            beam_size=1,
            language=language_hint,
        )
        return " ".join(seg.text.strip() for seg in segments if seg.text.strip())

    def translate(self, text: str) -> str:
        if not text:
            return ""
        encoded = self.tokenizer(text, return_tensors="np")
        input_ids = encoded["input_ids"][0].tolist()
        tokens = self.tokenizer.convert_ids_to_tokens(input_ids)
        result = self.translator.translate_batch(
            [tokens],
            beam_size=1,
            num_hypotheses=1,
            target_prefix=[[self.target_token]],
            prefix_bias_beta=0.5,
        )[0]
        filtered = [
            tok
            for tok in result.hypotheses[0]
            if tok not in {"<pad>", "</s>", "<unk>", self.target_token}
        ]
        return self.tokenizer.convert_tokens_to_string(filtered).strip()

    def tts(
        self,
        text: str,
        voice: Optional[str] = None,
        speaker_sample: Optional[bytes] = None,
    ) -> Tuple[np.ndarray, int]:
        xtts = get_xtts_adapter()
        if speaker_sample and not xtts:
            raise RuntimeError("XTTS is not available to process microphone samples.")
        if xtts and self.xtts_language and (speaker_sample or self.xtts_reference):
            try:
                audio, rate = xtts.synthesize(
                    text=text,
                    language=self.xtts_language,
                    speaker_sample=speaker_sample,
                    default_sample=self.xtts_reference,
                )
                if audio.size:
                    return self._normalise(audio), rate
            except Exception:
                self.logger.exception("XTTS synthesis failed")
                if speaker_sample:
                    raise RuntimeError("XTTS synthesis failed for provided speaker sample.")

        if self.kokoro is not None:
            try:
                generator = self.kokoro(text, voice=voice or self.kokoro_voice)
                chunks: list[np.ndarray] = []
                for _, _, audio in generator:
                    chunk = np.asarray(audio, dtype=np.float32)
                    if chunk.ndim > 1:
                        chunk = chunk.mean(axis=0)
                    if chunk.size:
                        chunks.append(chunk)
                if chunks:
                    waveform = np.concatenate(chunks)
                    if waveform.ndim > 1:
                        waveform = waveform.mean(axis=0)
                    duration = waveform.size / float(self.kokoro_sample_rate)
                    energy = float(np.max(np.abs(waveform))) if waveform.size else 0.0
                    if duration >= 0.8 and energy > 1e-4:
                        return self._normalise(waveform), self.kokoro_sample_rate
            except Exception:
                # fall back to pyttsx3
                pass

        fallback = self._tts_with_pyttsx3(text)
        if fallback is not None:
            return fallback
        raise RuntimeError(
            "Kokoro TTS is not installed or failed, and pyttsx3 fallback was unavailable."
        )

    def _tts_with_pyttsx3(self, text: str) -> Optional[Tuple[np.ndarray, int]]:
        try:
            engine = pyttsx3.init()
            engine.setProperty("rate", self.pyttsx3_rate)
            if self.pyttsx3_voice_hint:
                voice_hint = self.pyttsx3_voice_hint.lower()
                for voice in engine.getProperty("voices"):
                    if voice_hint in voice.name.lower():
                        engine.setProperty("voice", voice.id)
                        break

            with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as tmp:
                tmp_path = tmp.name
            try:
                engine.save_to_file(text, tmp_path)
                engine.runAndWait()
                engine.stop()
                data, sample_rate = sf.read(tmp_path, dtype="float32", always_2d=False)
            finally:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            if data.ndim > 1:
                data = data.mean(axis=1)
            if data.size == 0:
                return None
            return self._normalise(data), sample_rate
        except Exception:
            self.logger.exception("pyttsx3 synthesis failed")
            return None

    @staticmethod
    def _normalise(audio: np.ndarray) -> np.ndarray:
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if peak > 1e-4:
            return (audio / peak).astype(np.float32)
        return audio.astype(np.float32)


class PipelineRegistry:
    """Caches initialised pipelines so each language is loaded once."""

    def __init__(self) -> None:
        self._pipelines: Dict[str, TranslationPipeline] = {}

    def get(self, language: str) -> TranslationPipeline:
        if language not in LANGUAGE_CONFIG:
            raise ValueError(f"Unsupported language: {language}")
        if language not in self._pipelines:
            self._pipelines[language] = TranslationPipeline(language)
        return self._pipelines[language]

    def loaded_languages(self) -> List[str]:
        return list(self._pipelines.keys())


pipelines = PipelineRegistry()

__all__ = ["TranslationPipeline", "pipelines"]
