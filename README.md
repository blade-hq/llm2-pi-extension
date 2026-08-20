# BladeAI LLM2 extension for Pi and Oh My Pi

This repository contains the client extension for the official Pi and Oh My Pi clients.

The extension registers:

- the `llm2` Provider with a Portal-backed model catalog;
- `blade_web_search`;
- `blade_generate_image`.

The Portal backend stays private. This repository contains only the code that runs in the user's Pi or Oh My Pi process. Because client extensions execute locally, users can inspect the source before installing it.

## Install

Install a fixed Git tag:

```bash
pi install git:github.com/blade-hq/llm2-pi-extension@v0.1.5
omp plugin install git:github.com/blade-hq/llm2-pi-extension@v0.1.5
```

The same source works with both clients. The package manifest declares both `pi.extensions` and `omp.extensions`.

## Configure the Portal Key

Set the key in the shell:

```bash
export LLM2_API_KEY=sk-llm2-...
```

Or install the extension and run this command inside Pi or Oh My Pi:

```text
/login llm2
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
`<file>.llm2-purged.bak`. If the block carried an `apiKey`, that key is moved
into the client's credential store, so no re-login is needed.

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

## Security

This extension has the same local process permissions as Pi or Oh My Pi. Read the source and check the tag before installing or upgrading. Do not put a Portal key in the repository URL, source code, or issue reports.

## Development

```bash
bun test ./test.ts
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
  is about to delete.
