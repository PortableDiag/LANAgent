#!/usr/bin/env python3
"""
AI Content Detector Service
FastAPI microservice for detecting AI-generated text, images, and audio.
Runs on CPU by default, auto-detects and uses GPU when available.
"""

import os
import sys
import io
import time
import logging
import asyncio
import argparse
from typing import Optional
from contextlib import asynccontextmanager

import torch
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse

# Configure logging
logging.basicConfig(
    level=getattr(logging, os.environ.get("LOG_LEVEL", "INFO")),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("ai-detector")

# Model cache directory
CACHE_DIR = os.environ.get("TRANSFORMERS_CACHE", "./data/model-cache")
os.makedirs(CACHE_DIR, exist_ok=True)
os.environ["TRANSFORMERS_CACHE"] = CACHE_DIR
os.environ["HF_HOME"] = CACHE_DIR


class ModelManager:
    """Singleton that lazy-loads and caches ML models. Auto-detects CPU/GPU."""

    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self._image_model = None
        self._audio_model = None
        self._image_lock = asyncio.Lock()
        self._audio_lock = asyncio.Lock()
        logger.info(f"ModelManager initialized — device: {self.device}")

    async def get_image_model(self):
        if self._image_model is not None:
            return self._image_model
        async with self._image_lock:
            if self._image_model is not None:
                return self._image_model
            self._image_model = await asyncio.to_thread(self._load_image_model)
            return self._image_model

    async def get_audio_model(self):
        if self._audio_model is not None:
            return self._audio_model
        async with self._audio_lock:
            if self._audio_model is not None:
                return self._audio_model
            self._audio_model = await asyncio.to_thread(self._load_audio_model)
            return self._audio_model

    def _load_image_model(self):
        """Load ViT for AI image detection."""
        from transformers import AutoModelForImageClassification, AutoImageProcessor

        logger.info("Loading image detection model (AI-image-detector)...")
        start = time.time()

        model_name = "umm-maybe/AI-image-detector"
        processor = AutoImageProcessor.from_pretrained(model_name, cache_dir=CACHE_DIR)
        model = AutoModelForImageClassification.from_pretrained(
            model_name, cache_dir=CACHE_DIR
        ).to(self.device).eval()
        classifier = {"model": model, "processor": processor}

        elapsed = time.time() - start
        logger.info(f"Image model loaded in {elapsed:.1f}s on {self.device}")
        return classifier

    def _load_audio_model(self):
        """Load Whisper for audio transcription."""
        from transformers import pipeline

        logger.info("Loading audio model (Whisper tiny)...")
        start = time.time()

        model_name = "openai/whisper-tiny"
        if self.device == "cuda":
            model_name = "openai/whisper-base"

        transcriber = pipeline(
            "automatic-speech-recognition",
            model=model_name,
            device=0 if self.device == "cuda" else -1,
            model_kwargs={"cache_dir": CACHE_DIR},
        )

        elapsed = time.time() - start
        logger.info(f"Audio model loaded in {elapsed:.1f}s on {self.device}")
        return transcriber

    @property
    def loaded_models(self):
        models = []
        if self._image_model is not None:
            models.append("AI-image-detector")
        if self._audio_model is not None:
            models.append("whisper-tiny" if self.device == "cpu" else "whisper-base")
        return models


# Global model manager
model_manager = ModelManager()


class ImageDetector:
    """AI-generated image detection using distilled ViT classifier."""

    @staticmethod
    async def detect(image_bytes: bytes) -> dict:
        from PIL import Image

        try:
            image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        except Exception as e:
            return {
                "verdict": "error",
                "confidence": 0.0,
                "score": None,
                "reasoning": f"Failed to open image: {e}",
            }

        model_data = await model_manager.get_image_model()
        results = await asyncio.to_thread(
            ImageDetector._classify, image, model_data["model"], model_data["processor"]
        )

        # Normalize label names — different models use different labels
        # umm-maybe: {0: "artificial", 1: "human"}, Ateeqq: {0: "ai", 1: "hum"}
        ai_score = results.get("artificial", results.get("ai", 0.0))
        human_score = results.get("human", results.get("hum", 0.0))

        if ai_score > 0.65:
            verdict = "ai_generated"
            confidence = ai_score
        elif human_score > 0.65:
            verdict = "human"
            confidence = human_score
        else:
            verdict = "uncertain"
            confidence = max(ai_score, human_score)

        reasoning = (
            f"ViT classifier scores — AI: {ai_score:.3f}, Human: {human_score:.3f}. "
            f"Based on visual pattern analysis of texture, noise, and artifact signatures."
        )

        return {
            "verdict": verdict,
            "confidence": round(confidence, 3),
            "score": round(ai_score, 4),
            "reasoning": reasoning,
        }


    @staticmethod
    def _classify(image, model, processor):
        """Run ViT classification on an image."""
        device = next(model.parameters()).device
        inputs = processor(images=image, return_tensors="pt").to(device)
        with torch.no_grad():
            outputs = model(**inputs)
            probs = torch.softmax(outputs.logits, dim=-1)[0]

        # Map model labels to scores
        labels = model.config.id2label
        result = {}
        for idx, prob in enumerate(probs):
            label = labels.get(idx, f"label_{idx}").lower()
            result[label] = round(float(prob), 4)
        return result


class AudioDetector:
    """Audio AI detection via transcription then text analysis."""

    @staticmethod
    async def detect(audio_bytes: bytes, filename: str = "audio.wav") -> dict:
        import soundfile as sf
        import tempfile

        # Write to temp file for soundfile/librosa to read
        suffix = os.path.splitext(filename)[1] or ".wav"
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name

            # Transcribe
            transcriber = await model_manager.get_audio_model()
            result = await asyncio.to_thread(transcriber, tmp_path)
            transcript = result.get("text", "").strip()

            if not transcript:
                return {
                    "verdict": "error",
                    "confidence": 0.0,
                    "score": None,
                    "transcript": "",
                    "reasoning": "Could not transcribe audio — no speech detected.",
                }

            # Return transcript for Node.js to analyze via LLM
            return {
                "verdict": "transcribed",
                "confidence": 0.0,
                "score": None,
                "transcript": transcript,
                "reasoning": f"Audio transcribed ({len(transcript)} chars). Text analysis will be performed by the AI provider.",
            }

        except Exception as e:
            logger.error(f"Audio detection failed: {e}")
            return {
                "verdict": "error",
                "confidence": 0.0,
                "score": None,
                "transcript": "",
                "reasoning": f"Audio processing failed: {e}",
            }
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)


# --- FastAPI App ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(f"AI Content Detector starting on {model_manager.device}")
    yield
    logger.info("AI Content Detector shutting down")


app = FastAPI(title="AI Content Detector", version="1.0.0", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "device": model_manager.device,
        "cuda_available": torch.cuda.is_available(),
        "loaded_models": model_manager.loaded_models,
        "memory_mb": round(
            torch.cuda.memory_allocated() / 1024 / 1024, 1
        ) if torch.cuda.is_available() else None,
    }


@app.post("/detect/image")
async def detect_image(file: UploadFile = File(...)):
    try:
        start = time.time()
        image_bytes = await file.read()
        if len(image_bytes) == 0:
            raise HTTPException(status_code=400, detail="Empty file")
        result = await ImageDetector.detect(image_bytes)
        result["processing_time_ms"] = round((time.time() - start) * 1000)
        result["filename"] = file.filename
        return {"success": True, "result": result}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Image detection error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/detect/audio")
async def detect_audio(file: UploadFile = File(...)):
    try:
        start = time.time()
        audio_bytes = await file.read()
        if len(audio_bytes) == 0:
            raise HTTPException(status_code=400, detail="Empty file")
        result = await AudioDetector.detect(audio_bytes, file.filename or "audio.wav")
        result["processing_time_ms"] = round((time.time() - start) * 1000)
        result["filename"] = file.filename
        return {"success": True, "result": result}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Audio detection error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("DETECTOR_PORT", 5100)))
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    logger.info(f"Starting AI Content Detector on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
