"""Central configuration for the translation pipeline."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
TRANSLATION_MODEL_ID = os.getenv("TRANSLATION_MODEL_ID", "facebook/nllb-200-distilled-600M")
TRANSLATION_MODEL_DIR = Path(
    os.getenv(
        "TRANSLATION_MODEL_DIR",
        BASE_DIR / "models" / "nllb-200-distilled-600M",
    )
).resolve()

def _parse_origins(raw: str) -> list[str]:
    items = [item.strip() for item in raw.split(",")]
    return [item for item in items if item]

def _parse_bool(raw: str) -> bool:
    return raw.strip().lower() in {"1", "true", "yes", "on"}


ALLOWED_ORIGINS = _parse_origins(os.getenv("ALLOWED_ORIGINS", "*"))
XTTS_MODEL_NAME = os.getenv("XTTS_MODEL_NAME", "tts_models/multilingual/multi-dataset/xtts_v2")
XTTS_USE_GPU = _parse_bool(os.getenv("XTTS_USE_GPU", "false"))
XTTS_DEFAULT_SPEAKER_DIR = (
    Path(os.getenv("XTTS_DEFAULT_SPEAKER_DIR")).expanduser().resolve()
    if os.getenv("XTTS_DEFAULT_SPEAKER_DIR")
    else None
)

# Audio chunk settings (in seconds) used by the previous CLI tools. Retained for reference
# if you choose to implement streaming/microphone capture later.
DEFAULT_CHUNK_LENGTH = 2.0
DEFAULT_CHUNK_OVERLAP = 0.4
