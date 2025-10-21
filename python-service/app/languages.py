"""Language metadata for the translation service.

Each entry links the NLLB translation token with Kokoro voice information.
Extend the mapping to support additional locales.
"""

LANGUAGE_CONFIG = {
    "spanish": {
        "translation_token": "spa_Latn",
        "display_name": "Spanish",
        "source_lang_code": "eng_Latn",
        "kokoro_lang": "es",
        "kokoro_voice": "af_heart",
        "pyttsx3_voice_hint": "spanish",
        "xtts_language": "es",
    },
    "english": {
        "translation_token": "eng_Latn",
        "display_name": "English",
        "source_lang_code": "spa_Latn",
        "kokoro_lang": "en",
        "kokoro_voice": "af_heart",
        "pyttsx3_voice_hint": "english",
        "xtts_language": "en",
    },
}

DEFAULT_TARGET_LANGUAGE = "spanish"
DEFAULT_SOURCE_LANG = LANGUAGE_CONFIG[DEFAULT_TARGET_LANGUAGE]["source_lang_code"]

__all__ = ["LANGUAGE_CONFIG", "DEFAULT_TARGET_LANGUAGE", "DEFAULT_SOURCE_LANG"]
