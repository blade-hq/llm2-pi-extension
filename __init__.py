"""Hermes Agent integration for the BladeAI LLM2 Portal.

The module intentionally uses only the Python standard library for HTTP.  The
model profile is registered at import time (Hermes' model-provider contract),
while web and image providers are registered from ``register(ctx)``.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from providers import register_provider
from providers.base import ProviderProfile
from agent.web_search_provider import WebSearchProvider
from agent.image_gen_provider import ImageGenProvider, error_response, save_url_image, success_response

DEFAULT_BASE_URL = "https://llm2.yangl.com.cn/v1"


def _base_url() -> str:
    return os.getenv("LLM2_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/") or DEFAULT_BASE_URL


def _key() -> str:
    return os.getenv("LLM2_API_KEY", "").strip()


def _post(path: str, payload: Dict[str, Any], app_name: str) -> Dict[str, Any]:
    request = Request(
        f"{_base_url()}/{path.lstrip('/')}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {_key()}",
            "Content-Type": "application/json",
            "X-App-Name": app_name,
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8")[:300]
        except Exception:
            pass
        raise RuntimeError(f"HTTP {exc.code}{': ' + detail if detail else ''}") from exc
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(str(exc)) from exc


llm2 = ProviderProfile(
    name="llm2",
    aliases=("bladeai", "blade"),
    display_name="BladeAI LLM2",
    description="BladeAI Portal 兼容 OpenAI 接口",
    signup_url="https://llm2.yangl.com.cn",
    base_url=DEFAULT_BASE_URL,
    auth_type="api_key",
    env_vars=("LLM2_API_KEY", "LLM2_BASE_URL"),
    api_mode="chat_completions",
    default_headers={"X-App-Name": "hermes-llm2"},
)
register_provider(llm2)


class LLM2WebSearchProvider(WebSearchProvider):
    @property
    def name(self) -> str:
        return "llm2"

    @property
    def display_name(self) -> str:
        return "BladeAI LLM2 网络搜索"

    def is_available(self) -> bool:
        return bool(_key())

    def supports_search(self) -> bool:
        return True

    def supports_extract(self) -> bool:
        return False

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        query = (query or "").strip()
        if not query:
            return {"success": False, "error": "Query is required"}
        try:
            answer = _post("web-search", {"query": query}, "hermes-llm2-search").get("answer")
            if not isinstance(answer, str) or not answer.strip():
                return {"success": False, "error": "Portal response did not contain an answer"}
            return {
                "success": True,
                "data": {"web": [{"title": answer.strip()[:120], "url": "", "description": answer.strip(), "position": 1}]},
            }
        except Exception as exc:
            return {"success": False, "error": str(exc)}


class LLM2ImageGenProvider(ImageGenProvider):
    @property
    def name(self) -> str:
        return "llm2"

    @property
    def display_name(self) -> str:
        return "BladeAI LLM2 图片生成"

    def is_available(self) -> bool:
        return bool(_key())

    def list_models(self) -> List[Dict[str, Any]]:
        return [{"id": "gpt-image-2", "display": "GPT Image 2"}, {"id": "gpt-image-1.5", "display": "GPT Image 1.5"}]

    def capabilities(self) -> Dict[str, Any]:
        return {"modalities": ["text"], "max_reference_images": 0}

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": self.display_name,
            "badge": "paid",
            "tag": "通过 BladeAI Portal 生成图片",
            "env_vars": [{
                "key": "LLM2_API_KEY",
                "prompt": "BladeAI Portal Key（以 sk-llm2- 开头）",
                "url": "https://llm2.yangl.com.cn",
            }],
        }

    def generate(self, prompt: str, aspect_ratio: str = "landscape", **kwargs: Any) -> Dict[str, Any]:
        prompt = (prompt or "").strip()
        model = kwargs.get("model") or "gpt-image-2"
        size = kwargs.get("size")
        if not size:
            size = {"square": "1024x1024", "landscape": "1536x1024", "portrait": "1024x1536"}.get(aspect_ratio, "1536x1024")
        quality = kwargs.get("quality", "medium")
        if not prompt:
            return error_response(error="Prompt is required", error_type="invalid_input", provider=self.name, model=model, prompt=prompt, aspect_ratio=aspect_ratio)
        try:
            data = _post("images/generations", {"prompt": prompt, "model": model, "size": size, "quality": quality}, "hermes-llm2-image")
            items = data.get("data")
            url = items[0].get("url") if isinstance(items, list) and items and isinstance(items[0], dict) else None
            if not isinstance(url, str) or not url:
                return error_response(error="Portal response did not contain an image URL", error_type="provider_error", provider=self.name, model=model, prompt=prompt, aspect_ratio=aspect_ratio)
            # Portal image URLs may be short-lived. Materialise them through
            # Hermes' official image cache so downstream tools do not need to
            # fetch the URL again. Keep the URL as a fallback for unusual
            # Hermes installations where the optional downloader is absent.
            try:
                local_image = save_url_image(url, prefix="llm2")
                image = str(local_image)
            except Exception:
                image = url
            response = {"image": image, "model": model, "prompt": prompt, "aspect_ratio": aspect_ratio, "provider": self.name}
            if image != url:
                response["extra"] = {"source_url": url}
            return success_response(**response)
        except Exception as exc:
            return error_response(error=str(exc), error_type="provider_error", provider=self.name, model=model, prompt=prompt, aspect_ratio=aspect_ratio)


def register(ctx: Any) -> None:
    ctx.register_web_search_provider(LLM2WebSearchProvider())
    ctx.register_image_gen_provider(LLM2ImageGenProvider())
