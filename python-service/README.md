# Global Language Translation Service (Python)

FastAPI application that exposes a local speech ➝ translation ➝ speech pipeline built with Whisper, CTranslate2, and Kokoro. Deploy alongside the web client or consume it directly as a REST API.

## Features
- `/transcribe` – uploads audio, returns transcript + translated text.
- `/translate` – plain text translation.
- `/tts` – neural text-to-speech when Kokoro is installed.
- Falls back to pyttsx3 when Kokoro voices are unavailable so English/Spanish
   speech is always produced offline.
- `/tts/clone` – XTTS-based cloning endpoint that accepts microphone samples (via multipart form data) to synthesise in English or Spanish. Defaults to built-in voices if no sample provided.
- `/languages` & `/health` – runtime metadata and readiness probes.
- Ships with English ↔︎ Spanish translation and TTS presets; extend `app/languages.py` for more locales.

## Quick start
```bash
cd python-service
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# Convert the translation model once (creates ./models/nllb-200-distilled-600M)
python download_models.py --quantization int8

# (Optional) Enable neural TTS support
pip install "kokoro==0.7.16"

# Run the API
uvicorn app:app --host 0.0.0.0 --port 8000
```

Visit `http://localhost:8000/docs` for the interactive OpenAPI explorer.

## Render deployment
1. Set up a Render **Web Service** with the following:
   - **Environment**: `Python`
   - **Python Version**: 3.11 (add `runtime.txt` with `python-3.11.9`)
   - **Build Command**: `pip install --upgrade pip && pip install -r requirements.txt && python download_models.py --quantization int8 --force`
   - **Start Command**: `uvicorn app:app --host 0.0.0.0 --port $PORT`
2. (Optional) Add environment variables if you customise the defaults:
   - `WHISPER_MODEL` – Whisper checkpoint (default `small`)
   - `TRANSLATION_MODEL_ID` – Hugging Face model ID (default `facebook/nllb-200-distilled-600M`)
   - `TRANSLATION_MODEL_DIR` – Absolute path to the converted CTranslate2 folder
   - `ALLOWED_ORIGINS` – Comma-separated list for CORS (default `*`)
   - `XTTS_MODEL_NAME` – XTTS model identifier (default `tts_models/multilingual/multi-dataset/xtts_v2`)
   - `XTTS_USE_GPU` – Set to `true` when deploying on a GPU to speed up cloning
   - `XTTS_DEFAULT_SPEAKER_DIR` – Optional directory of fallback `*.wav` samples (named `{lang}.wav`)
3. (Optional) If you need Kokoro TTS on Render, append `&& pip install "kokoro==0.7.16"` to the build command or add a separate deploy hook.

> **Note:** Converting the NLLB checkpoint is compute-intensive and can take several minutes during the initial build. Consider attaching a persistent disk and re-using the generated `models/` directory between deploys.

## Repository layout
```
python-service/
├── app/
│   ├── __init__.py       # FastAPI app + routes
│   ├── config.py         # Environment-tunable settings
│   ├── languages.py      # Language metadata
│   └── pipeline.py       # Whisper + NLLB + Kokoro orchestration
├── download_models.py    # Helper to fetch/convert Hugging Face checkpoints
├── models/               # Place converted CTranslate2 models here
└── requirements.txt
```

Feel free to extend `app/languages.py` with extra locales and redeploy.
