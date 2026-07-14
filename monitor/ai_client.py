#!/usr/bin/env python3
"""
ai_client.py — provider-agnostic LLM client for the monitor.

Use whatever AI you want. Set AI_PROVIDER (default "anthropic") and the matching
key; everything else (scoring, classification, email triage) calls complete().

  AI_PROVIDER=anthropic   ANTHROPIC_API_KEY=...   (default; model: claude-haiku-4-5-20251001)
  AI_PROVIDER=openai      OPENAI_API_KEY=...       (model: gpt-4o-mini)
  AI_PROVIDER=gemini      GEMINI_API_KEY=...       (model: gemini-2.0-flash)
  AI_PROVIDER=local       AI_BASE_URL=http://localhost:11434/v1  (Ollama / any
                          OpenAI-compatible server; AI_MODEL=llama3.1, AI_API_KEY optional)

Override the model for any provider with AI_MODEL. Fail-open: complete() raises on
error and callers already degrade to keyword-only results.
"""

import json
import os

import requests

PROVIDER = os.environ.get("AI_PROVIDER", "anthropic").lower()
_MODEL_OVERRIDE = os.environ.get("AI_MODEL", "")

_DEFAULT_MODEL = {
    "anthropic": "claude-haiku-4-5-20251001",
    "openai": "gpt-4o-mini",
    "gemini": "gemini-2.0-flash",
    "local": os.environ.get("AI_MODEL", "llama3.1"),
}


def default_model() -> str:
    return _MODEL_OVERRIDE or _DEFAULT_MODEL.get(PROVIDER, "gpt-4o-mini")


def available() -> bool:
    """True if the selected provider has what it needs to run."""
    if PROVIDER == "anthropic":
        return bool(os.environ.get("ANTHROPIC_API_KEY"))
    if PROVIDER == "openai":
        return bool(os.environ.get("OPENAI_API_KEY"))
    if PROVIDER == "gemini":
        return bool(os.environ.get("GEMINI_API_KEY"))
    if PROVIDER == "local":
        return bool(os.environ.get("AI_BASE_URL"))
    return False


def complete(prompt: str, max_tokens: int = 2000, model: str | None = None, timeout: int = 60) -> str:
    """Send a single user prompt, return the model's text. Raises on failure."""
    model = model or default_model()

    if PROVIDER == "anthropic":
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"],
                     "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": model, "max_tokens": max_tokens,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=timeout,
        )
        if r.status_code != 200:
            raise RuntimeError(f"anthropic {r.status_code}: {r.text[:150]}")
        return r.json()["content"][0]["text"]

    if PROVIDER in ("openai", "local"):
        base = os.environ.get("AI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        key = os.environ.get("OPENAI_API_KEY") or os.environ.get("AI_API_KEY", "sk-local")
        r = requests.post(
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model, "max_tokens": max_tokens,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=timeout,
        )
        if r.status_code != 200:
            raise RuntimeError(f"{PROVIDER} {r.status_code}: {r.text[:150]}")
        return r.json()["choices"][0]["message"]["content"]

    if PROVIDER == "gemini":
        key = os.environ["GEMINI_API_KEY"]
        r = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
            headers={"Content-Type": "application/json"},
            json={"contents": [{"parts": [{"text": prompt}]}],
                  "generationConfig": {"maxOutputTokens": max_tokens}},
            timeout=timeout,
        )
        if r.status_code != 200:
            raise RuntimeError(f"gemini {r.status_code}: {r.text[:150]}")
        return r.json()["candidates"][0]["content"]["parts"][0]["text"]

    raise RuntimeError(f"unknown AI_PROVIDER: {PROVIDER!r}")
