import importlib.util
import json
import os
import sys
import types
import unittest
from urllib.error import HTTPError
from unittest.mock import patch


def _load_plugin():
    providers = types.ModuleType("providers")
    providers.registered = []
    providers.register_provider = providers.registered.append
    base = types.ModuleType("providers.base")

    class ProviderProfile:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    base.ProviderProfile = ProviderProfile
    providers.base = base
    web = types.ModuleType("agent.web_search_provider")

    class WebSearchProvider:
        pass

    web.WebSearchProvider = WebSearchProvider
    image = types.ModuleType("agent.image_gen_provider")

    class ImageGenProvider:
        pass

    image.ImageGenProvider = ImageGenProvider
    image.save_url_image = lambda url, **kwargs: "/tmp/hermes-llm2.png"
    image.success_response = lambda **kwargs: {"success": True, **kwargs}
    image.error_response = lambda **kwargs: {"success": False, **kwargs}
    agent = types.ModuleType("agent")
    sys.modules.update({"providers": providers, "providers.base": base, "agent": agent, "agent.web_search_provider": web, "agent.image_gen_provider": image})
    spec = importlib.util.spec_from_file_location("llm2_plugin", "__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


class HermesPluginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin = _load_plugin()

    def setUp(self):
        os.environ.pop("LLM2_API_KEY", None)
        os.environ.pop("LLM2_BASE_URL", None)

    def test_availability(self):
        search, image = self.plugin.LLM2WebSearchProvider(), self.plugin.LLM2ImageGenProvider()
        self.assertFalse(search.is_available())
        self.assertFalse(image.is_available())
        os.environ["LLM2_API_KEY"] = "fake-key"
        self.assertTrue(search.is_available())
        self.assertTrue(image.is_available())

    def test_search_success_and_headers(self):
        os.environ["LLM2_API_KEY"] = "fake-key"
        with patch.object(self.plugin, "urlopen", return_value=FakeResponse({"answer": "A concise answer"})) as opened:
            result = self.plugin.LLM2WebSearchProvider().search("query")
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["web"][0]["description"], "A concise answer")
        request = opened.call_args.args[0]
        self.assertEqual(request.headers["Authorization"], "Bearer fake-key")
        self.assertEqual(request.headers["X-app-name"], "hermes-llm2-search")
        self.assertIn("/web-search", request.full_url)

    def test_search_failure(self):
        os.environ["LLM2_API_KEY"] = "fake-key"
        with patch.object(self.plugin, "urlopen", return_value=FakeResponse({})): 
            self.assertFalse(self.plugin.LLM2WebSearchProvider().search("q")["success"])
        with patch.object(self.plugin, "urlopen", side_effect=HTTPError("https://llm2.yangl.com.cn/v1/web-search", 401, "unauthorized", {}, None)):
            self.assertFalse(self.plugin.LLM2WebSearchProvider().search("q")["success"])

    def test_image_success_and_override(self):
        os.environ["LLM2_API_KEY"] = "fake-key"
        os.environ["LLM2_BASE_URL"] = "https://example.test/v1"
        with patch.object(self.plugin, "urlopen", return_value=FakeResponse({"data": [{"url": "https://img.test/a.png"}]})) as opened:
            result = self.plugin.LLM2ImageGenProvider().generate("cat", aspect_ratio="square", model="gpt-image-1.5", quality="high")
        self.assertTrue(result["success"])
        self.assertEqual(result["image"], "/tmp/hermes-llm2.png")
        self.assertEqual(result["extra"]["source_url"], "https://img.test/a.png")
        request = opened.call_args.args[0]
        self.assertEqual(request.headers["X-app-name"], "hermes-llm2-image")
        body = json.loads(request.data)
        self.assertEqual(body["size"], "1024x1024")
        self.assertEqual(body["model"], "gpt-image-1.5")

    def test_image_missing_url(self):
        os.environ["LLM2_API_KEY"] = "fake-key"
        with patch.object(self.plugin, "urlopen", return_value=FakeResponse({"data": [{}]})):
            self.assertFalse(self.plugin.LLM2ImageGenProvider().generate("cat")["success"])

    def test_default_base_url(self):
        os.environ["LLM2_API_KEY"] = "fake-key"
        with patch.object(self.plugin, "urlopen", return_value=FakeResponse({"answer": "ok"})) as opened:
            self.plugin.LLM2WebSearchProvider().search("q")
        self.assertTrue(opened.call_args.args[0].full_url.startswith("https://llm2.yangl.com.cn/v1/"))


if __name__ == "__main__":
    unittest.main()
