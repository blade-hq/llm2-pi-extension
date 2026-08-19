import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	const pi = {
		registerProvider(provider: unknown, config?: unknown) {
			registrations.push(config === undefined ? provider : { provider, config });
		},
		registerTool() {},
	};
	return {
		pi,
		registrations,
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
			expect(registrations).toHaveLength(2);
			expect(registrations[0]?.config.models?.map(model => model.id)).toEqual(["test-model"]);
			expect(registrations[1]?.provider).toBe("llm2");
			expect(registrations[1]?.config.models).toBeUndefined();
			expect(registrations[1]?.config.fetchDynamicModels).toBeFunction();
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

function writeConfig(client: ".omp" | ".pi", file: string, content: string): string {
	const dir = join(sandbox, client, "agent");
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
		await extension(piHarness().pi as never);
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

	test("keeps providers a mapping when llm2 was the only entry", async () => {
		const path = writeConfig(".omp", "models.yml", "providers:\n  llm2:\n    baseUrl: https://llm2.yangl.com.cn/v1\n    models:\n");
		await extension(piHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe("providers: {}\n");
	});

	test("removes the llm2 block from models.json", async () => {
		const path = writeConfig(".pi", "models.json", JSON.stringify({
			providers: { llm2: { baseUrl: "https://llm2.yangl.com.cn/v1", models: [] }, litellm: { baseUrl: "http://x/v1" } },
		}));
		await extension(piHarness().pi as never);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ providers: { litellm: { baseUrl: "http://x/v1" } } });
	});

	test("leaves a file without an llm2 block byte-identical and writes no backup", async () => {
		const content = "providers:\n  gpu22:\n    baseUrl: http://gpu22:30001/v1\n    models:\n      - id: qwen3.5-122b-int4\n";
		const path = writeConfig(".omp", "models.yml", content);
		await extension(piHarness().pi as never);
		expect(readFileSync(path, "utf-8")).toBe(content);
		expect(() => readFileSync(`${path}.llm2-purged.bak`, "utf-8")).toThrow();
	});
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	rmSync(sandbox, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
});
