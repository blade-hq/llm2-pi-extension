import { afterAll, describe, expect, test } from "bun:test";

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
	let registered: unknown;
	const pi = {
		registerProvider(provider: unknown, config?: unknown) {
			registered = config === undefined ? provider : { provider, config };
		},
		registerTool() {},
	};
	return { pi, get registered() { return registered; } };
}

describe("llm2 provider authentication", () => {
	test("Pi native provider refresh uses a stored API-key credential", async () => {
		const harness = piHarness();
		await extension(harness.pi as never);
		const provider = harness.registered as {
			id: string;
			refreshModels(context: { credential: { type: "api_key"; key: string }; signal: AbortSignal; allowNetwork: boolean; publish(x: unknown): Promise<boolean> }): Promise<void>;
			getModels(): Array<{ id: string }>;
		};
		expect(provider.id).toBe("llm2");
		await provider.refreshModels({
			credential: { type: "api_key", key: "stored-pi-key" },
			signal: new AbortController().signal,
			allowNetwork: true,
			async publish(publication: { update?: () => void }) { publication.update?.(); return true; },
		});
		expect(provider.getModels().map(model => model.id)).toEqual(["test-model"]);
		expect(requests.at(-1)?.authorization).toBe("Bearer stored-pi-key");
	});

	test("OMP dynamic discovery uses the resolved login key", async () => {
		const harness = piHarness();
		(harness.pi as Record<string, unknown>).pi = {};
		await extension(harness.pi as never);
		const registration = harness.registered as { provider: string; config: { fetchDynamicModels(key?: string): Promise<Array<{ id: string }>> } };
		expect(registration.provider).toBe("llm2");
		const models = await registration.config.fetchDynamicModels("stored-omp-key");
		expect(models.map(model => model.id)).toEqual(["test-model"]);
		expect(requests.at(-1)?.authorization).toBe("Bearer stored-omp-key");
	});
});

afterAll(() => { globalThis.fetch = originalFetch; });
