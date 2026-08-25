# BladeAI LLM2 extension for Pi, Oh My Pi, and Hermes Agent

This repository contains client integrations for Pi, Oh My Pi, and Nous Research Hermes Agent.

The extension registers:

- the `llm2` Provider with a Portal-backed model catalog;
- `blade_web_search`;
- `blade_generate_image`.

Hermes additionally gets the native `llm2` model, web-search, and image-gen providers.

The Portal backend stays private. This repository contains only the code that runs in the user's Pi or Oh My Pi process. Because client extensions execute locally, users can inspect the source before installing it.

## Install

Install a fixed Git tag:

```bash
pi install git:github.com/blade-hq/llm2-pi-extension@v0.1.6
omp plugin install git:github.com/blade-hq/llm2-pi-extension@v0.1.6
hermes plugins install blade-hq/llm2-pi-extension --enable
```

The same source works with both clients. The package manifest declares both `pi.extensions` and `omp.extensions`.
Hermes discovers the root `plugin.yaml` and `__init__.py`; the TypeScript entrypoint remains unchanged.

## Configure the Portal Key

Set the key in the shell:

```bash
export LLM2_API_KEY=sk-llm2-...
```

Or install the extension and run this command inside Pi or Oh My Pi:

```text
/login llm2
```

Hermes uses environment variables (it has no `/login` flow for this plugin):

```bash
export LLM2_API_KEY=sk-llm2-...
export LLM2_BASE_URL=https://llm2.yangl.com.cn/v1  # optional
hermes --provider llm2 -m <model-id>
```

The key is sent to the BladeAI Portal for model catalog access and model requests. It is not sent to the upstream catalog provider.

Pi stores the key in `~/.pi/agent/auth.json`; Oh My Pi stores it in its credential database. Model refresh reads the credential through each client's supported auth path, so users do not need to export `LLM2_API_KEY` after `/login llm2`.

## Stale provider blocks

A hand-written `providers.llm2` block in `~/.pi/agent/models.json` or
`~/.omp/agent/models.yml` shadows the provider this extension registers. A block
that is missing its `models` array also fails schema validation, and the client
then discards the whole config file, so every other provider in it stops
resolving too.

The extension deletes such a block on startup and backs the original file up as
`<file>.llm2-purged.bak`. If the block carried an `apiKey`, that key is first
moved into the client's credential store — Oh My Pi's store for `omp`,
`auth.json` for Pi — so no re-login is needed.

If that key cannot be stored, the block is **left in place**: it may hold the
only copy, and deleting it would lose the credential. The extension then asks
you to run `/login llm2`; the block is cleaned up on the next launch.

Each client only ever touches the config file it reads itself. Cleaning up the
other client's file from here would delete a block that may hold the only copy
of its key, which cannot be migrated across clients -- so Pi fixes Pi and Oh My
Pi fixes Oh My Pi, each on its own next launch.

## Use

After the Portal administrator enables the Provider and configures the model catalog, select a model such as:

```bash
pi --model llm2/<model-id>
omp --model llm2/<model-id>
```

The extension refreshes models through the Portal endpoint:

```text
GET https://llm2.yangl.com.cn/pi/catalog
Authorization: Bearer <your Portal key>
```

Tools:

- `blade_web_search` calls the Portal web-search endpoint.
- `blade_generate_image` calls the Portal image-generation endpoint.

For Hermes, select the native backends in `config.yaml` (or `hermes tools`):

```yaml
web:
  search_backend: llm2
image_gen:
  provider: llm2
```

BladeAI search returns one result containing the Portal's model-written
`answer`, not a raw SERP list, and does not support extraction. Image generation
is text-only with `gpt-image-2` / `gpt-image-1.5`; aspect ratios map to Portal sizes.

## Security

This extension has the same local process permissions as Pi or Oh My Pi. Read the source and check the tag before installing or upgrading. Do not put a Portal key in the repository URL, source code, or issue reports.

## Development

```bash
bun test ./test.ts
python3 -m unittest test_hermes.py
```

The extension registers its provider and tools through the public APIs. Beyond
that it touches two pieces of client state, both described above:

- **Config files.** It reads `models.json` / `models.yml`, and deletes a stale
  `providers.llm2` block from them, backing the original up first. In YAML the
  rest of the file is left byte-for-byte intact. JSON is re-serialized, keeping
  key order and the file's own indentation; a file whose numbers exceed what
  JSON round-trips exactly is left untouched instead.
- **Credential store.** It reads the stored `llm2` key so model discovery works
  after `/login`, and writes one back only when rescuing a key from a block it
  is about to delete. On Pi that means `auth.json`, written directly: the
  registry Pi exposes to extensions has readers only, no way to store a
  credential. An existing entry is never overwritten.
