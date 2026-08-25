# BladeAI LLM2：Pi、Oh My Pi 与 Hermes Agent 扩展

本仓库提供 BladeAI LLM2 的客户端扩展，支持官方 Pi、Oh My Pi，以及 Nous
Research Hermes Agent。Portal 后端保持私有；这里的代码只在用户自己的客户端
进程中运行，安装前可以自行检查源码。

## 安装

Pi / Oh My Pi：

```bash
pi install git:github.com/blade-hq/llm2-pi-extension@v0.1.6
omp plugin install git:github.com/blade-hq/llm2-pi-extension@v0.1.6
```

Hermes Agent：

```bash
hermes plugins install blade-hq/llm2-pi-extension --enable
```

Hermes 安装时会显示隐藏输入框，提示“请粘贴 BladeAI Portal Key（以
`sk-llm2-` 开头）”。直接粘贴 Key 并回车即可，Hermes 会自动保存；普通用户
不需要理解或手动设置环境变量。若跳过了提示，可运行 `hermes config` 再填写。

## 配置与使用

Pi / Oh My Pi 可以设置 `LLM2_API_KEY`，或在客户端执行：

```text
/login llm2
```

选择模型：

```bash
pi --model llm2/<model-id>
omp --model llm2/<model-id>
hermes --provider llm2 -m <model-id>
```

Hermes 中可在 `hermes tools` 里选择后端，也可以在 `config.yaml` 写入：

```yaml
web:
  search_backend: llm2
image_gen:
  provider: llm2
```

高级用户可以用 `LLM2_API_KEY` 覆盖已保存的 Key，用 `LLM2_BASE_URL` 覆盖默认
地址 `https://llm2.yangl.com.cn/v1`。

## 能力说明

- `llm2` 模型提供商：通过 Portal 的 OpenAI 兼容 Chat Completions 接口工作。
- Hermes 网络搜索：调用 `/v1/web-search`，返回 BladeAI 整理后的最终 `answer`，封装为一条结果；不是原始 SERP 列表，也不支持网页抽取。
- Hermes 图片生成：调用 `/v1/images/generations`，支持 `gpt-image-2`、`gpt-image-1.5`。生成图片会自动下载到 Hermes 的图片缓存，避免下游再次下载临时 URL；当前只支持文生图。
- Pi / Oh My Pi 仍提供原有的 `blade_web_search` 和 `blade_generate_image` 工具。

模型目录来自：

```text
GET https://llm2.yangl.com.cn/pi/catalog
Authorization: Bearer <Portal Key>
```

## 安全提示

扩展与 Pi、Oh My Pi、Hermes 进程拥有相同的本地权限。安装或升级前请检查源码，
正式使用建议固定可信 tag 或 commit。不要把 Portal Key 写入仓库、URL、测试
fixture 或 issue。

## 开发与测试

```bash
bun test ./test.ts
python3 -m unittest test_hermes.py
```

Hermes 插件位于根目录的 `plugin.yaml` 和 `__init__.py`；Pi / Oh My Pi 仍从
`package.json` 的 `pi.extensions` / `omp.extensions` 加载 `index.ts`，两套入口
互不影响。
