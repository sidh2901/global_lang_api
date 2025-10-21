"""Coqui XTTS integration helpers."""
from __future__ import annotations

import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
import soundfile as sf

try:
    from TTS.api import TTS as CoquiTTS  # type: ignore
    from TTS.config.shared_configs import BaseAudioConfig, BaseDatasetConfig  # type: ignore
    from TTS.tts.configs.xtts_config import XttsConfig  # type: ignore
    from TTS.tts.models.xtts import XttsArgs, XttsAudioConfig  # type: ignore
    try:  # torch >= 2.6+
        from torch.serialization import add_safe_globals  # type: ignore
    except ImportError:
        def add_safe_globals(_):  # type: ignore
            return None
    add_safe_globals([XttsConfig, XttsArgs, XttsAudioConfig, BaseDatasetConfig, BaseAudioConfig])
except Exception:  # pragma: no cover
    CoquiTTS = None  # type: ignore

from .config import XTTS_MODEL_NAME, XTTS_USE_GPU

logger = logging.getLogger(__name__)


class XTTSAdapter:
    """Thin wrapper around Coqui XTTS with thread-safe synthesis."""

    def __init__(self, model_name: str, use_gpu: bool) -> None:
        if CoquiTTS is None:
            raise RuntimeError("Coqui TTS is not installed. Install the `TTS` package to enable XTTS.")
        logger.info("Loading XTTS model %s (gpu=%s)", model_name, use_gpu)
        self.tts = CoquiTTS(model_name, gpu=use_gpu)
        self.model_name = model_name
        self.use_gpu = use_gpu
        self._lock = threading.Lock()

    def synthesize(
        self,
        text: str,
        language: str,
        speaker_sample: Optional[bytes] = None,
        default_sample: Optional[Path] = None,
    ) -> Tuple[np.ndarray, int]:
        """Generate speech with optional cloning sample."""
        speaker_path: Optional[str] = None
        temp_speaker_path: Optional[str] = None
        if speaker_sample:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
                tmp.write(speaker_sample)
                tmp.flush()
                speaker_path = tmp.name
                temp_speaker_path = tmp.name
        elif default_sample:
            speaker_path = str(default_sample)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_out:
            output_path = tmp_out.name

        kwargs = {
            "text": text,
            "language": language,
            "file_path": output_path,
        }
        if speaker_path:
            kwargs["speaker_wav"] = speaker_path

        try:
            with self._lock:
                self.tts.tts_to_file(**kwargs)
            data, sample_rate = sf.read(output_path, dtype="float32", always_2d=False)
            if data.ndim > 1:
                data = data.mean(axis=1)
            return data.astype(np.float32), int(sample_rate)
        finally:
            try:
                os.unlink(output_path)
            except OSError:
                logger.warning("Failed to delete temporary XTTS output file %s", output_path)
            if temp_speaker_path:
                try:
                    os.unlink(temp_speaker_path)
                except OSError:
                    logger.warning("Failed to delete temporary XTTS speaker file %s", temp_speaker_path)


_adapter: Optional[XTTSAdapter] = None
_adapter_lock = threading.Lock()


def get_xtts_adapter() -> Optional[XTTSAdapter]:
    """Retrieve a shared XTTS adapter instance, or None if unavailable."""
    global _adapter
    if _adapter is not None:
        return _adapter
    if CoquiTTS is None:
        logger.warning("Coqui TTS is not available; XTTS features disabled.")
        return None
    with _adapter_lock:
        if _adapter is None:
            try:
                _adapter = XTTSAdapter(XTTS_MODEL_NAME, XTTS_USE_GPU)
            except Exception:
                logger.exception("Failed to initialise XTTS adapter.")
                _adapter = None
        return _adapter
