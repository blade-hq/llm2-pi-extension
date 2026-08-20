import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The extension clears stale provider blocks out of the real config files on
// startup, so every test in this file must run against a throwaway HOME.
const originalHome = process.env.HOME;
const sandbox = mkdtempSync(join(tmpdir(), "llm2-ext-"));
process.env.HOME = sandbox;
for (const key of ["PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE"]) delete process.env[key];

const requests: Array<{ url: string; authorization: string | null }> = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const headers = new Headers(init?.headers);
	requests.push({ url: String(input), authorization: headers.get("authorization") });
	return new Response(JSON.stringify({
		models: [{
			id: "test-model",
			name: "Test Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		}],
	}), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { default: extension } = await import("./index.ts");

function piHarness() {
	const registrations: unknown[] = [];
	const tools: Array<Record<string, unknown>> = [];
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<void>>> = {};
	const pi = {
		registerProvider(provider: unknown, config?: unknown) {
			registrations.push(config === undefined ? provider : { provider, config });
		},
		registerTool(tool: Record<string, unknown>) { tools.push(tool); },
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
			(handlers[event] ??= []).push(handler);
		},
	};
	return {
		pi,
		registrations,
		tools,
		handlers,
		sessionStart(ctx: unknown) { return Promise.all((handlers.session_start ?? []).map(h => h(null, ctx))); },
		get registered() { return registrations.at(-1); },
	};
}

describe("llm2 provider authentication", () => {
	test("Pi config-form refresh uses a stored API-key credential", async () => {
		const harness = piHarness();
		await extension(harness.pi as never);
		const registration = harness.registered as {
			provider: string;
			config: { refreshModels(context: { credential?: { type: "api_key"; key: string }; signal?: AbortSignal }): Promise<Array<{ id: string }>> };
		};
		expect(registration.provider).toBe("llm2");
		const models = await registration.config.refreshModels({
			credential: { type: "api_key", key: "stored-pi-key" },
			signal: new AbortController().signal,
		});
		expect(models.map(model => model.id)).toEqual(["test-model"]);
		expect(requests.at(-1)?.authorization).toBe("Bearer stored-pi-key");
	});

	test("Pi catalog refresh works when the host omits signal", async () => {
		const harness = piHarness();
		await extension(harness.pi as never);
		const registration = harness.registered as {
			config: { refreshModels(context: { credential?: { type: "api_key"; key: string } }): Promise<Array<{ id: string }>> };
		};
		const models = await registration.config.refreshModels({
			credential: { type: "api_key", key: "stored-pi-key" },
		});
		expect(models.map(model => model.id)).toEqual(["test-model"]);
	});

	test("OMP startup publishes models when an environment key is available", async () => {
		const previous = process.env.LLM2_API_KEY;
		process.env.LLM2_API_KEY = "stored-omp-key";
		try {
			const harness = piHarness();
			(harness.pi as Record<string, unknown>).pi = {};
			await extension(harness.pi as never);
			const registrations = harness.registrations as Array<{
				provider: string;
				config: { models?: Array<{ id: string }>; fetchDynamicModels?(key?: string): Promise<Array<{ id: string }>> };
			}>;
			// Exactly one registration: a second one replaces the first, so
			// re-registering without models would discard the seeded catalog.
			expect(registrations).toHaveLength(1);
			expect(registrations[0]?.provider).toBe("llm2");
			expect(registrations[0]?.config.models?.map(model => model.id)).toEqual(["test-model"]);
			expect(registrations[0]?.config.fetchDynamicModels).toBeFunction();
			expect(requests.at(-1)?.authorization).toBe("Bearer stored-omp-key");
		} finally {
			if (previous === undefined) delete process.env.LLM2_API_KEY;
			else process.env.LLM2_API_KEY = previous;
		}
	});

	test("OMP dynamic discovery uses the resolved login key without an environment key", async () => {
		const harness = piHarness();
		(harness.pi as Record<string, unknown>).pi = {};
		await extension(harness.pi as never);
		const registration = harness.registered as { provider: string; config: { fetchDynamicModels(key?: string): Promise<Array<{ id: string }>> } };
		const models = await registration.config.fetchDynamicModels("stored-omp-key");
		expect(models.map(model => model.id)).toEqual(["test-model"]);
		expect(requests.at(-1)?.authorization).toBe("Bearer stored-omp-key");
	});
});

// Oh My Pi is the client that reads models.yml; Pi reads models.json.
// Without an explicit namespace it gets a working in-memory credential store,
// since a client that cannot store a key will not delete a block holding one.
function ompHarness(namespace?: Record<string, unknown>) {
	const harness = piHarness();
	const store: Record<string, string> = {};
	(harness.pi as Record<string, unknown>).pi = namespace ?? {
		discoverAuthStorage: async () => ({
			peekApiKey: (id: string) => store[id],
			set: (id: string, credential: { key: string }) => { store[id] = credential.key; },
		}),
	};
	return harness;
}

function authFile(): string {
	return join(sandbox, ".pi", "agent", "auth.json");
}

function readAuth(): Record<string, { type?: string; key?: string }> {
	try {
		return JSON.parse(readFileSync(authFile(), "utf-8"));
	} catch {
		return {};
	}
}

function writeConfig(client: ".omp" | ".pi", file: string, content: string, profile?: string): string {
	const dir = profile ? join(sandbox, client, "profiles", profile, "agent") : join(sandbox, client, "agent");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, content);
	return path;
}

describe("stale provider config cleanup", () => {
	beforeEach(() => { rmSync(join(sandbox, ".omp"), { recursive: true, force: true }); rmSync(join(sandbox, ".pi"), { recursive: true, force: true }); });

	test("removes the llm2 block from models.yml and leaves other providers untouched", async () => {
		const path = writeConfig(".omp", "models.yml", [
			"providers:",
			"  llm2:",
			"    baseUrl: https://llm2.yangl.com.cn/v1",
			"    models:",
			"  gpu22:",
			"    baseUrl: http://gpu22:30001/v1",
			"    models:",
			"      - id: qwen3.5-122b-int4",
			"",
		].join("\n"));
		await extension(ompHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe([
			"providers:",
			"  gpu22:",
			"    baseUrl: http://gpu22:30001/v1",
			"    models:",
			"      - id: qwen3.5-122b-int4",
			"",
		].join("\n"));
		expect(readFileSync(`${path}.llm2-purged.bak`, "utf-8")).toContain("llm2:");
	});

	test("finds llm2 after a provider that spells out its models", async () => {
		const path = writeConfig(".omp", "models.yml", [
			"providers:",
			"  gpu22:",
			"    baseUrl: http://y/v1",
			"    models:",
			"      - id: qwen3.5-122b-int4",
			"        input:",
			"          - text",
			"  llm2:",
			"    models:",
			"",
		].join("\n"));
		await extension(ompHarness().pi as never);
		const after = readFileSync(path, "utf-8");
		expect(after).not.toContain("llm2");
		expect(after).toContain("qwen3.5-122b-int4");
	});

	test("keeps providers a mapping when llm2 was the only entry", async () => {
		const path = writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    baseUrl: https://llm2.yangl.com.cn/v1\n    models:\n");
		await extension(ompHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe("providers: {}\n");
	});

	test("keeps providers a mapping when a later top-level section follows", async () => {
		// `aliases` entries share the provider indentation but are not providers.
		const path = writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    models:\naliases:\n  foo: bar\n");
		await extension(ompHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe("providers: {}\naliases:\n  foo: bar\n");
	});

	test("keeps the providers-line comment when the map is emptied", async () => {
		const path = writeConfig(".omp", "models.yml", "providers: # local catalog\n  llm2:\n    models:\n");
		await extension(ompHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe("providers: {} # local catalog\n");
	});

	test("removes a quoted provider key", async () => {
		const path = writeConfig(".omp", "models.yml", 'providers:\n  "llm2":\n    "apiKey": sk-quoted\n    models:\n  gpu22:\n    baseUrl: http://x/v1\n');
		await extension(ompHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe("providers:\n  gpu22:\n    baseUrl: http://x/v1\n");
	});

	test("keeps a block intact when a comment sits at a shallower indent", async () => {
		const path = writeConfig(".omp", "models.yml", [
			"providers:",
			"  llm2:",
			"    baseUrl: https://x/v1",
			"# an unindented comment inside the block",
			"    models:",
			"  gpu22:",
			"    baseUrl: http://y/v1",
			"",
		].join("\n"));
		await extension(ompHarness().pi as never);
		const after = readFileSync(path, "utf-8");
		// The whole block must go; leaving `models:` behind would be invalid YAML.
		expect(after).not.toContain("llm2");
		expect(after).not.toContain("models:");
		expect((Bun as never as { YAML: { parse(t: string): unknown } }).YAML.parse(after)).toEqual({
			providers: { gpu22: { baseUrl: "http://y/v1" } },
		});
	});

	test("removes the block when the providers key carries an inline comment", async () => {
		const path = writeConfig(".omp", "models.yml", "providers: # local catalog\n  llm2:\n    models:\n  gpu22:\n    baseUrl: http://y/v1\n");
		await extension(ompHarness().pi as never);
		const after = readFileSync(path, "utf-8");
		expect(after).not.toContain("llm2");
		expect(after).toContain("providers: # local catalog");
	});

	test("removes the block under a quoted providers key", async () => {
		const path = writeConfig(".omp", "models.yml", 'providers:\n  llm2:\n    models:\n  gpu22:\n    baseUrl: http://y/v1\n'.replace("providers:", '"providers":'));
		await extension(ompHarness().pi as never);
		expect(readFileSync(path, "utf-8")).not.toContain("llm2");
	});

	test("leaves the file alone when the edit cannot be verified", async () => {
		// Flow style: the parser sees llm2, the line edit cannot express the removal.
		const content = "providers: {llm2: {models: null}, gpu22: {baseUrl: http://y/v1}}\n";
		const path = writeConfig(".omp", "models.yml", content);
		await extension(ompHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe(content);
		expect(() => readFileSync(`${path}.llm2-purged.bak`, "utf-8")).toThrow();
	});

	test("declines a file whose providers value is not a mapping", async () => {
		const content = "providers: disabled\n";
		const path = writeConfig(".omp", "models.yml", content);
		// Must not throw: a crash here would stop the provider registering at all.
		await extension(ompHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe(content);
	});

	test("declines a models.json whose providers value is not an object", async () => {
		const content = JSON.stringify({ providers: "disabled" });
		const path = writeConfig(".pi", "models.json", content);
		await extension(piHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe(content);
	});

	test("updates the symlink target instead of replacing the link", async () => {
		// Dotfile managers link these paths; the link must survive.
		const store = join(sandbox, "dotfiles");
		mkdirSync(store, { recursive: true });
		const real = join(store, "models.yml");
		writeFileSync(real, "providers:\n  llm2:\n    models:\n  gpu22:\n    baseUrl: http://y/v1\n");
		const dir = join(sandbox, ".omp", "agent");
		mkdirSync(dir, { recursive: true });
		const link = join(dir, "models.yml");
		symlinkSync(real, link);

		await extension(ompHarness().pi as never);

		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(real, "utf-8")).not.toContain("llm2");
		expect(readFileSync(`${real}.llm2-purged.bak`, "utf-8")).toContain("llm2");
	});

	test("preserves the original file mode", async () => {
		// These files hold API keys; a 0600 config must not come back 0644.
		const path = writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    models:\n  gpu22:\n    baseUrl: http://y/v1\n");
		chmodSync(path, 0o600);
		await extension(ompHarness().pi as never);
		expect(readFileSync(path, "utf-8")).not.toContain("llm2");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("removes the llm2 block from models.json", async () => {
		const path = writeConfig(".pi", "models.json", JSON.stringify({
			providers: { llm2: { baseUrl: "https://llm2.yangl.com.cn/v1", models: [] }, litellm: { baseUrl: "http://x/v1" } },
		}));
		await extension(piHarness().pi as never);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ providers: { litellm: { baseUrl: "http://x/v1" } } });
	});

	test("follows the original indentation of models.json", async () => {
		const path = writeConfig(".pi", "models.json", JSON.stringify(
			{ providers: { llm2: { models: [] }, litellm: { baseUrl: "http://x/v1" } } }, null, 4) + "\n");
		await extension(piHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe(JSON.stringify({ providers: { litellm: { baseUrl: "http://x/v1" } } }, null, 4) + "\n");
	});

	test("leaves models.json alone when a number would not round-trip exactly", async () => {
		for (const literal of ["9007199254740993", "9.007199254740993e15"]) {
			const content = `{\n  "providers": {\n    "llm2": {"models": []},\n    "other": {"quirk": ${literal}}\n  }\n}\n`;
			const path = writeConfig(".pi", "models.json", content);
			await extension(piHarness().pi as never);
			expect(readFileSync(path, "utf-8")).toBe(content);
		}
	});

	test("still cleans up when digits appear inside strings", async () => {
		// `08` inside a date would look unpreservable if strings were scanned.
		const path = writeConfig(".pi", "models.json", JSON.stringify({
			providers: {
				llm2: { models: [] },
				other: { baseUrl: "http://gpu22:30001/v1", note: "2026-08-20", cost: 0.5 },
			},
		}, null, 2) + "\n");
		await extension(piHarness().pi as never);
		const after = JSON.parse(readFileSync(path, "utf-8"));
		expect(Object.keys(after.providers)).toEqual(["other"]);
		expect(after.providers.other.note).toBe("2026-08-20");
	});

	test("leaves a file without an llm2 block byte-identical and writes no backup", async () => {
		const content = "providers:\n  gpu22:\n    baseUrl: http://gpu22:30001/v1\n    models:\n      - id: qwen3.5-122b-int4\n";
		const path = writeConfig(".omp", "models.yml", content);
		await extension(ompHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe(content);
		expect(() => readFileSync(`${path}.llm2-purged.bak`, "utf-8")).toThrow();
	});
});

describe("api key handling", () => {
	beforeEach(() => { rmSync(join(sandbox, ".omp"), { recursive: true, force: true }); rmSync(join(sandbox, ".pi"), { recursive: true, force: true }); });

	test("Oh My Pi seeds the catalog with a key from its credential store", async () => {
		const harness = piHarness();
		(harness.pi as Record<string, unknown>).pi = {
			discoverAuthStorage: async () => ({ peekApiKey: () => "sk-stored-omp" }),
		};
		await extension(harness.pi as never);
		const registration = harness.registered as { config: { models?: Array<{ id: string }> } };
		expect(registration.config.models?.map(model => model.id)).toEqual(["test-model"]);
		expect(requests.at(-1)?.authorization).toBe("Bearer sk-stored-omp");
	});

	test("Oh My Pi stores a key rescued from the deleted provider block", async () => {
		writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    apiKey: sk-rescued-omp\n    models:\n");
		const stored: Array<{ provider: string; key: string }> = [];
		const harness = piHarness();
		(harness.pi as Record<string, unknown>).pi = {
			discoverAuthStorage: async () => ({
				peekApiKey: () => undefined,
				set: (provider: string, credential: { key: string }) => { stored.push({ provider, key: credential.key }); },
			}),
		};
		await extension(harness.pi as never);
		expect(stored).toEqual([{ provider: "llm2", key: "sk-rescued-omp" }]);
		expect(requests.at(-1)?.authorization).toBe("Bearer sk-rescued-omp");
	});

	test("Pi writes a rescued key into auth.json", async () => {
		const path = writeConfig(".pi", "models.json", JSON.stringify({ providers: { llm2: { apiKey: "sk-rescued-pi", models: [] } } }));
		const harness = piHarness();
		await extension(harness.pi as never);
		expect(readAuth().llm2).toEqual({ type: "api_key", key: "sk-rescued-pi" });
		expect(readFileSync(path, "utf-8")).not.toContain("llm2");
		const notes: string[] = [];
		await harness.sessionStart({ ui: { notify: (message: string) => notes.push(message) } });
		expect(notes.join("")).toContain("已存入凭据库");
	});

	test("Pi keeps the block when the key cannot be stored", async () => {
		// auth.json is a directory here, so writing it fails: the block holds the
		// only copy of the key and must survive.
		mkdirSync(authFile(), { recursive: true });
		const content = JSON.stringify({ providers: { llm2: { apiKey: "sk-only-copy", models: [] } } });
		const path = writeConfig(".pi", "models.json", content);
		const harness = piHarness();
		await extension(harness.pi as never);
		expect(readFileSync(path, "utf-8")).toBe(content);
		const notes: string[] = [];
		await harness.sessionStart({ ui: { notify: (message: string) => notes.push(message) } });
		expect(notes.join("")).toContain("/login");
		rmSync(authFile(), { recursive: true, force: true });
	});

	test("writes auth.json through a symlink and keeps it 0600", async () => {
		const store = join(sandbox, "dotfiles");
		mkdirSync(store, { recursive: true });
		const real = join(store, "auth.json");
		writeFileSync(real, JSON.stringify({ deepseek: { type: "api_key", key: "sk-ds" } }, null, 2));
		chmodSync(real, 0o600);
		mkdirSync(join(sandbox, ".pi", "agent"), { recursive: true });
		symlinkSync(real, authFile());
		writeConfig(".pi", "models.json", JSON.stringify({ providers: { llm2: { apiKey: "sk-through-link", models: [] } } }));

		await extension(piHarness().pi as never);

		expect(lstatSync(authFile()).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(real, "utf-8")).llm2).toEqual({ type: "api_key", key: "sk-through-link" });
		expect(statSync(real).mode & 0o777).toBe(0o600);
	});

	test("keeps the block when the existing auth.json entry is unusable", async () => {
		mkdirSync(join(sandbox, ".pi", "agent"), { recursive: true });
		writeFileSync(authFile(), JSON.stringify({ llm2: null }, null, 2));
		const content = JSON.stringify({ providers: { llm2: { apiKey: "sk-only-copy", models: [] } } });
		const path = writeConfig(".pi", "models.json", content);
		const harness = piHarness();
		await extension(harness.pi as never);
		// Neither source may be lost: the entry is not ours to replace, so the
		// block stays put.
		expect(readFileSync(path, "utf-8")).toBe(content);
		expect(readAuth().llm2).toBeNull();
		const notes: string[] = [];
		await harness.sessionStart({ ui: { notify: (message: string) => notes.push(message) } });
		expect(notes.join("")).toContain("/login");
	});

	test("treats an oauth entry as an existing credential", async () => {
		mkdirSync(join(sandbox, ".pi", "agent"), { recursive: true });
		writeFileSync(authFile(), JSON.stringify({ llm2: { type: "oauth", access: "tok", refresh: "tok" } }, null, 2));
		const path = writeConfig(".pi", "models.json", JSON.stringify({ providers: { llm2: { apiKey: "sk-redundant", models: [] } } }));
		await extension(piHarness().pi as never);
		expect(readFileSync(path, "utf-8")).not.toContain("llm2");
		expect(readAuth().llm2).toEqual({ type: "oauth", access: "tok", refresh: "tok" } as never);
	});

	test("does not replace a dangling auth.json symlink", async () => {
		mkdirSync(join(sandbox, ".pi", "agent"), { recursive: true });
		symlinkSync(join(sandbox, "dotfiles", "missing-auth.json"), authFile());
		const content = JSON.stringify({ providers: { llm2: { apiKey: "sk-only-copy", models: [] } } });
		const path = writeConfig(".pi", "models.json", content);
		await extension(piHarness().pi as never);
		expect(lstatSync(authFile()).isSymbolicLink()).toBe(true);
		expect(readFileSync(path, "utf-8")).toBe(content);
	});

	test("Pi does not overwrite an existing auth.json entry", async () => {
		mkdirSync(join(sandbox, ".pi", "agent"), { recursive: true });
		writeFileSync(authFile(), JSON.stringify({ llm2: { type: "oauth", access: "existing" } }, null, 2));
		const path = writeConfig(".pi", "models.json", JSON.stringify({ providers: { llm2: { apiKey: "sk-new", models: [] } } }));
		await extension(piHarness().pi as never);
		expect(readAuth().llm2).toEqual({ type: "oauth", access: "existing" } as never);
		expect(readFileSync(path, "utf-8")).not.toContain("llm2");
	});

	test("Oh My Pi leaves Pi's config file untouched", async () => {
		// Deleting the other client's block would strip the only copy of its key:
		// it cannot be authenticated from here, so that client cleans up itself.
		const piPath = writeConfig(".pi", "models.json", JSON.stringify({ providers: { llm2: { apiKey: "sk-pi-key", models: [] } } }));
		const piBefore = readFileSync(piPath, "utf-8");
		writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    apiKey: sk-omp-key\n    models:\n");
		const stored: Array<{ provider: string; key: string }> = [];
		const harness = ompHarness({
			discoverAuthStorage: async () => ({
				peekApiKey: () => undefined,
				set: (provider: string, credential: { key: string }) => { stored.push({ provider, key: credential.key }); },
			}),
		});
		await extension(harness.pi as never);
		expect(stored).toEqual([{ provider: "llm2", key: "sk-omp-key" }]);
		expect(readFileSync(piPath, "utf-8")).toBe(piBefore);
	});

	test("Pi leaves Oh My Pi's config file untouched", async () => {
		const ompPath = writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    apiKey: sk-omp-key\n    models:\n");
		const ompBefore = readFileSync(ompPath, "utf-8");
		writeConfig(".pi", "models.json", JSON.stringify({ providers: { llm2: { apiKey: "sk-pi-key", models: [] } } }));
		await extension(piHarness().pi as never);
		expect(readAuth().llm2?.key).toBe("sk-pi-key");
		expect(readFileSync(ompPath, "utf-8")).toBe(ompBefore);
	});

	test("rescues from the active profile, not the unprofiled file", async () => {
		writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    apiKey: sk-unprofiled\n    models:\n");
		writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    apiKey: sk-active-profile\n    models:\n", "work");
		const stored: Array<{ key: string }> = [];
		process.env.OMP_PROFILE = "work";
		try {
			const harness = piHarness();
			(harness.pi as Record<string, unknown>).pi = {
				discoverAuthStorage: async () => ({
					peekApiKey: () => undefined,
					set: (_provider: string, credential: { key: string }) => { stored.push({ key: credential.key }); },
				}),
			};
			await extension(harness.pi as never);
			expect(stored).toEqual([{ key: "sk-active-profile" }]);
		} finally {
			delete process.env.OMP_PROFILE;
		}
	});

	test("resolves an environment-variable reference instead of storing it verbatim", async () => {
		// OMP reads apiKey as the name of an environment variable.
		writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    apiKey: LLM2_PORTAL_TOKEN\n    models:\n");
		const stored: Array<{ key: string }> = [];
		process.env.LLM2_PORTAL_TOKEN = "sk-from-env";
		try {
			const harness = piHarness();
			(harness.pi as Record<string, unknown>).pi = {
				discoverAuthStorage: async () => ({
					peekApiKey: () => undefined,
					set: (_provider: string, credential: { key: string }) => { stored.push({ key: credential.key }); },
				}),
			};
			await extension(harness.pi as never);
			expect(stored).toEqual([{ key: "sk-from-env" }]);
		} finally {
			delete process.env.LLM2_PORTAL_TOKEN;
		}
	});

	test("skips migration when the reference resolves to nothing", async () => {
		// Nothing usable to move, so the block stays put rather than losing it.
		const content = JSON.stringify({ providers: { llm2: { apiKey: "$LLM2_MISSING_VAR", models: [] } } });
		const path = writeConfig(".pi", "models.json", content);
		await extension(piHarness().pi as never);
		expect(readAuth().llm2).toBeUndefined();
		expect(readFileSync(path, "utf-8")).not.toContain("llm2");
	});

	test("Pi ignores OMP_PROFILE when locating its own config", async () => {
		// Pi has no profile feature; OMP_PROFILE must not move its active path.
		writeConfig(".pi", "models.json", JSON.stringify({ providers: { llm2: { apiKey: "sk-pi-unprofiled", models: [] } } }));
		process.env.OMP_PROFILE = "work";
		try {
			await extension(piHarness().pi as never);
			expect(readAuth().llm2?.key).toBe("sk-pi-unprofiled");
		} finally {
			delete process.env.OMP_PROFILE;
		}
	});

	test("Pi ignores PI_CONFIG_DIR when locating its own config", async () => {
		// PI_CONFIG_DIR is an Oh My Pi setting; Pi never reads it.
		writeConfig(".pi", "models.json", JSON.stringify({ providers: { llm2: { apiKey: "sk-pi-default-root", models: [] } } }));
		process.env.PI_CONFIG_DIR = ".somewhere-else";
		try {
			await extension(piHarness().pi as never);
			expect(readAuth().llm2?.key).toBe("sk-pi-default-root");
		} finally {
			delete process.env.PI_CONFIG_DIR;
		}
	});

	test("Pi keeps an uppercase literal key instead of treating it as a reference", async () => {
		writeConfig(".pi", "models.json", JSON.stringify({ providers: { llm2: { apiKey: "ABC123", models: [] } } }));
		await extension(piHarness().pi as never);
		expect(readAuth().llm2?.key).toBe("ABC123");
	});

	test("Oh My Pi resolves a lowercase environment-variable name", async () => {
		writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    apiKey: llm2_portal_token\n    models:\n");
		const stored: Array<{ key: string }> = [];
		process.env.llm2_portal_token = "sk-from-lowercase-env";
		try {
			const harness = piHarness();
			(harness.pi as Record<string, unknown>).pi = {
				discoverAuthStorage: async () => ({
					peekApiKey: () => undefined,
					set: (_p: string, credential: { key: string }) => { stored.push({ key: credential.key }); },
				}),
			};
			await extension(harness.pi as never);
			expect(stored).toEqual([{ key: "sk-from-lowercase-env" }]);
		} finally {
			delete process.env.llm2_portal_token;
		}
	});

	test("Oh My Pi keeps a literal key that cannot be an environment-variable name", async () => {
		writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    apiKey: sk-llm2-literal\n    models:\n");
		const stored: Array<{ key: string }> = [];
		const harness = piHarness();
		(harness.pi as Record<string, unknown>).pi = {
			discoverAuthStorage: async () => ({
				peekApiKey: () => undefined,
				set: (_p: string, credential: { key: string }) => { stored.push({ key: credential.key }); },
			}),
		};
		await extension(harness.pi as never);
		expect(stored).toEqual([{ key: "sk-llm2-literal" }]);
	});

	test("does not tell the user to log in when a stored key already works", async () => {
		mkdirSync(join(sandbox, ".pi", "agent"), { recursive: true });
		writeFileSync(authFile(), JSON.stringify({ llm2: { type: "api_key", key: "sk-already-stored" } }, null, 2));
		writeConfig(".pi", "models.json", JSON.stringify({ providers: { llm2: { apiKey: "sk-redundant", models: [] } } }));
		const harness = piHarness();
		await extension(harness.pi as never);
		const notes: string[] = [];
		await harness.sessionStart({ ui: { notify: (message: string) => notes.push(message) } });
		expect(notes.join("")).not.toContain("/login");
		// The stored key wins; the redundant one is dropped with the block.
		expect(readAuth().llm2?.key).toBe("sk-already-stored");
	});

	test("stops authenticating once the registry no longer has a credential", async () => {
		// Simulates /logout while the client stays open: the key cached at load
		// time must not keep tool calls authenticated.
		const harness = ompHarness({ discoverAuthStorage: async () => ({ peekApiKey: () => "sk-stored" }) });
		await extension(harness.pi as never);
		const search = harness.tools.find(tool => tool.name === "blade_web_search") as {
			execute(id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown): Promise<{ content: Array<{ text: string }> }>;
		};
		const result = await search.execute("call-1", { query: "x" }, undefined, undefined, {
			modelRegistry: { getApiKeyForProvider: async () => undefined },
		});
		expect(result.content[0]?.text).toContain("没有找到 Portal API Key");
	});

	test("model refresh stops using a credential removed after load", async () => {
		let credential: string | undefined = "sk-stored";
		const harness = ompHarness({ discoverAuthStorage: async () => ({ peekApiKey: () => credential }) });
		await extension(harness.pi as never);
		credential = undefined; // /logout while the client stays open
		const registration = harness.registered as { config: { fetchDynamicModels(key?: string): Promise<unknown> } };
		expect(registration.config.fetchDynamicModels()).rejects.toThrow("没有 Portal API Key");
	});

	test("purges nothing when the provider id names an inherited property", async () => {
		const content = JSON.stringify({ providers: { litellm: { baseUrl: "http://x/v1" } } }, null, 2) + "\n";
		const path = writeConfig(".pi", "models.json", content);
		process.env.LLM2_PROVIDER_ID = "toString";
		try {
			await extension(piHarness().pi as never);
			expect(readFileSync(path, "utf-8")).toBe(content);
			expect(() => readFileSync(`${path}.llm2-purged.bak`, "utf-8")).toThrow();
		} finally {
			delete process.env.LLM2_PROVIDER_ID;
		}
	});

});

afterAll(() => {
	globalThis.fetch = originalFetch;
	rmSync(sandbox, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
});
