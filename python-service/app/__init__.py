"""FastAPI application exposing the translation pipeline."""

from __future__ import annotations

import asyncio
import io
import tempfile
from pathlib import Path
from typing import Optional

import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from .languages import DEFAULT_TARGET_LANGUAGE, LANGUAGE_CONFIG
from .pipeline import pipelines

app = FastAPI(
    title="Global Language Translation Service",
    version="1.0.0",
    description="Speech-to-text, machine translation and optional TTS served via FastAPI.",
)


class TranslateRequest(BaseModel):
    text: str
    target_language: Optional[str] = DEFAULT_TARGET_LANGUAGE


class TranslateResponse(BaseModel):
    translated: str
    target_language: str


class TTSRequest(BaseModel):
    text: str
    target_language: Optional[str] = DEFAULT_TARGET_LANGUAGE
    voice: Optional[str] = None


async def _save_upload(upload: UploadFile) -> Path:
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    suffix = Path(upload.filename or "audio").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(data)
        return Path(tmp.name)


def _resolve_language(lang: Optional[str]) -> str:
    return (lang or DEFAULT_TARGET_LANGUAGE).strip().lower()


def _get_pipeline(lang: Optional[str]):
    language = _resolve_language(lang)
    try:
        return pipelines.get(language), language
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.on_event("startup")
async def preload_default_pipeline() -> None:
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, pipelines.get, DEFAULT_TARGET_LANGUAGE)


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "available_languages": list(LANGUAGE_CONFIG.keys()),
            "loaded_languages": pipelines.loaded_languages(),
        }
    )


@app.get("/languages")
def languages() -> JSONResponse:
    return JSONResponse({"languages": LANGUAGE_CONFIG})


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language_hint: Optional[str] = Form(default=None),
    target_language: Optional[str] = Form(default=DEFAULT_TARGET_LANGUAGE),
) -> JSONResponse:
    pipeline, lang = _get_pipeline(target_language)
    tmp_path = await _save_upload(file)
    try:
        transcript = pipeline.transcribe(tmp_path, language_hint=language_hint)
    finally:
        tmp_path.unlink(missing_ok=True)
    translation = pipeline.translate(transcript)
    return JSONResponse(
        {
            "transcript": transcript,
            "translated": translation,
            "target_language": lang,
        }
    )


@app.post("/translate", response_model=TranslateResponse)
def translate(request: TranslateRequest) -> TranslateResponse:
    pipeline, lang = _get_pipeline(request.target_language)
    translation = pipeline.translate(request.text)
    return TranslateResponse(translated=translation, target_language=lang)


@app.post("/tts")
def tts(request: TTSRequest) -> StreamingResponse:
    pipeline, lang = _get_pipeline(request.target_language)
    try:
        audio, sample_rate = pipeline.tts(request.text, request.voice)
    except RuntimeError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    if audio.size == 0:
        raise HTTPException(status_code=500, detail="No audio generated.")
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV")
    buffer.seek(0)
    headers = {"X-Target-Language": lang}
    return StreamingResponse(buffer, media_type="audio/wav", headers=headers)


__all__ = ["app"]
