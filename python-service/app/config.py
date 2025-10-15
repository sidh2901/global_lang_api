"""Central configuration for the translation pipeline."""
from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parents[1]

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
TRANSLATION_MODEL_ID = os.getenv("TRANSLATION_MODEL_ID", "facebook/nllb-200-distilled-600M")
TRANSLATION_MODEL_DIR = Path(
    os.getenv(
        "TRANSLATION_MODEL_DIR",
        BASE_DIR / "models" / "nllb-200-distilled-600M",
    )
).resolve()

# Audio chunk settings (in seconds) used by the previous CLI tools. Retained for reference
# if you choose to implement streaming/microphone capture later.
DEFAULT_CHUNK_LENGTH = 2.0
DEFAULT_CHUNK_OVERLAP = 0.4
