import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "https://llm2.yangl.com.cn/v1";
const DEFAULT_PROVIDER_ID = "llm2";
const DEFAULT_PROVIDER_NAME = "BladeAI LLM2";
const CATALOG_TIMEOUT_MS = 30_000;

type ModelConfig = {
	id: string;
	name: string;
	api?: string;
	baseUrl?: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Record<string, unknown>;
	compat?: Record<string, unknown>;
	headers?: Record<string, string>;
};

type CatalogResponse = {
	models?: Array<Record<string, unknown>>;
	headers?: Record<string, string>;
};
type CredentialLike = { type?: string; key?: string; access?: string };

function env(name: string, fallback = ""): string {
	return process.env[name]?.trim() || fallback;
}

function baseURL(): string {
	return env("LLM2_BASE_URL", DEFAULT_BASE_URL).replace(/\/$/, "");
}

function portalKey(credential?: CredentialLike): string | undefined {
	if (credential?.type === "oauth" && credential.access?.trim()) return credential.access.trim();
	if (credential?.type === "api_key" && credential.key?.trim()) return credential.key.trim();
	return process.env.LLM2_API_KEY?.trim() || undefined;
}

function catalogURL(base: string): string {
	return `${base.replace(/\/v1\/?$/, "")}/pi/catalog`;
}

function numberValue(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function toModel(value: Record<string, unknown>): ModelConfig {
	const fallbackCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const api = String(value.api ?? "openai-completions");
	const base = baseURL();
	return {
		id: String(value.id ?? ""),
		name: String(value.name ?? value.id ?? ""),
		api,
		baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : base,
		reasoning: Boolean(value.reasoning),
		thinkingLevelMap: value.thinkingLevelMap as ModelConfig["thinkingLevelMap"],
		input: (Array.isArray(value.input) ? value.input : ["text"]).filter(
			(item): item is "text" | "image" => item === "text" || item === "image",
		),
		cost: (value.cost as ModelConfig["cost"]) ?? fallbackCost,
		contextWindow: numberValue(value.contextWindow, 128_000),
		maxTokens: numberValue(value.maxTokens, 16_384),
		samplingParams: value.samplingParams as Record<string, unknown> | undefined,
		compat: value.compat as Record<string, unknown> | undefined,
	};
}

async function readJSON(response: Response): Promise<Record<string, unknown>> {
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch {
		throw new Error(`Portal returned HTTP ${response.status} with an invalid JSON response`);
	}
}

type CatalogResult = { models: ModelConfig[]; headers?: Record<string, string> };

async function fetchCatalog(signal: AbortSignal, key: string): Promise<CatalogResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(catalogURL(baseURL()), {
			signal: controller.signal,
			headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
		});
		if (!response.ok) throw new Error(`Portal catalog returned HTTP ${response.status}`);
		const payload = (await readJSON(response)) as CatalogResponse;
		if (!Array.isArray(payload.models)) throw new Error("Portal catalog response has no models array");
		const headers = payload.headers;
		const models = payload.models.map(toModel).filter(model => model.id.length > 0);
		if (headers && Object.keys(headers).length > 0) {
			for (const model of models) {
				model.headers = { ...headers };
			}
		}
		return { models, headers };
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

async function keyFromContext(ctx: { modelRegistry?: unknown }): Promise<string | undefined> {
	const providerID = env("LLM2_PROVIDER_ID", DEFAULT_PROVIDER_ID);
	const registry = ctx.modelRegistry as {
		getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
		getProviderAuth?: (provider: string) => Promise<{ auth?: { apiKey?: string } } | undefined>;
		getAuth?: (provider: string) => Promise<{ auth?: { apiKey?: string } } | undefined>;
	} | undefined;
	if (registry?.getApiKeyForProvider) {
		const key = await registry.getApiKeyForProvider(providerID);
		if (key && key !== "NO_AUTH" && key !== "kNoAuth") return key;
	}
	if (registry?.getProviderAuth) {
		const auth = await registry.getProviderAuth(providerID);
		const key = auth?.auth?.apiKey?.trim();
		if (key) return key;
	}
	if (registry?.getAuth) {
		const auth = await registry.getAuth(providerID);
		const key = auth?.auth?.apiKey?.trim();
		if (key) return key;
	}
	return portalKey();
}

async function portalRequest(
	ctx: { modelRegistry?: unknown },
	path: string,
	init: RequestInit,
): Promise<Response> {
	const key = await keyFromContext(ctx);
	if (!key) throw new Error("没有找到 Portal API Key，请运行 /login llm2，或设置 LLM2_API_KEY");
	const headers = new Headers(init.headers);
	headers.set("Accept", "application/json");
	headers.set("Authorization", `Bearer ${key}`);
	return fetch(`${baseURL()}${path}`, { ...init, headers });
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function generateImage(
	ctx: { modelRegistry?: unknown },
	params: { prompt: string; model?: string; size?: string; quality?: string },
	signal?: AbortSignal,
) {
	const response = await portalRequest(ctx, "/images/generations", {
		method: "POST",
		signal,
		headers: { "Content-Type": "application/json", "X-App-Name": "pi-llm2-image" },
		body: JSON.stringify({
			prompt: params.prompt,
			model: params.model || "gpt-image-2",
			size: params.size || "1024x1024",
			...(params.quality ? { quality: params.quality } : {}),
		}),
	});
	const payload = await readJSON(response);
	if (!response.ok) {
		const error = payload.error as { message?: string } | undefined;
		throw new Error(error?.message || `图片生成失败（HTTP ${response.status}）`);
	}
	const data = payload.data as Array<{ url?: string }> | undefined;
	const url = data?.[0]?.url;
	if (!url) throw new Error("图片接口没有返回图片链接");
	return url;
}

function registerTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "blade_web_search",
		label: "BladeAI 网络搜索",
		description: "使用 BladeAI 的专属网络搜索能力查询最新信息，并返回带链接的最终回答。适合新闻、产品更新、文档变化和需要实时信息的问题。",
		promptSnippet: "BladeAI 网络搜索：查询实时信息并返回最终回答。",
		parameters: Type.Object({
			query: Type.String({ description: "要搜索的问题，尽量写清楚时间范围和目标。" }),
			instructions: Type.Optional(Type.String({ description: "可选：对回答风格或范围的补充要求。" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const response = await portalRequest(ctx, "/web-search", {
					method: "POST",
					signal,
					headers: { "Content-Type": "application/json", "X-App-Name": "pi-llm2-search" },
					body: JSON.stringify({ query: params.query, instructions: params.instructions }),
				});
				const payload = await readJSON(response);
				if (!response.ok) {
					const error = payload.error as { message?: string } | undefined;
					throw new Error(error?.message || `网络搜索失败（HTTP ${response.status}）`);
				}
				if (typeof payload.answer !== "string" || !payload.answer.trim()) throw new Error("搜索接口没有返回回答");
				return textResult(payload.answer, { model: payload.model, id: payload.id });
			} catch (error) {
				return textResult(`网络搜索失败：${errorMessage(error)}`, { error: true });
			}
		},
	});

	pi.registerTool({
		name: "blade_generate_image",
		label: "BladeAI 图片生成",
		description: "根据文字描述生成图片。返回图片链接；如果客户端支持图片工具结果，也会把生成的图片带回当前对话。",
		promptSnippet: "BladeAI 图片生成：根据描述生成图片并返回链接。",
		parameters: Type.Object({
			prompt: Type.String({ description: "图片内容、构图、风格、文字和尺寸的详细描述。" }),
			model: Type.Optional(Type.String({ description: "图片模型，默认 gpt-image-2。" })),
			size: Type.Optional(Type.String({ description: "图片尺寸，例如 1024x1024、1536x1024 或 1024x1536。" })),
			quality: Type.Optional(Type.String({ description: "图片质量：low、medium 或 high。" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const url = await generateImage(ctx, params, signal);
				return textResult(`图片已生成：${url}`, { url });
			} catch (error) {
				return textResult(`图片生成失败：${errorMessage(error)}`, { error: true });
			}
		},
	});
}

export default async function bladeAIExtension(pi: ExtensionAPI) {
	const isOMP = "pi" in (pi as unknown as Record<string, unknown>);
	const providerID = env("LLM2_PROVIDER_ID", DEFAULT_PROVIDER_ID);
	const providerName = env("LLM2_PROVIDER_NAME", DEFAULT_PROVIDER_NAME);
	// Pass the resolved value rather than "$LLM2_API_KEY": OMP treats apiKey
	// as an environment-variable name while Pi accepts interpolation syntax.
	// A literal resolved value works in both clients and remains in process memory.
	const apiKey = process.env.LLM2_API_KEY?.trim() || undefined;

	const providerConfig = {
		name: providerName,
		baseUrl: baseURL(),
		api: "openai-completions",
		...(apiKey ? { apiKey } : {}),
		authHeader: true,
		headers: { "X-App-Name": env("LLM2_APP_NAME", "pi-llm2") },
		// Pi uses refreshModels; Oh My Pi uses fetchDynamicModels. Both fields are
		// intentional: each client ignores the field it does not implement. Do not
		// add `models: []`: OMP treats an explicit models array as authoritative and
		// skips fetchDynamicModels.
		refreshModels: async (context: { credential?: CredentialLike; signal: AbortSignal }) => {
			const key = portalKey(context.credential);
			if (!key) throw new Error("没有 Portal API Key，请运行 /login llm2 或设置 LLM2_API_KEY");
			const catalog = await fetchCatalog(context.signal, key);
			return catalog.models;
		},
		fetchDynamicModels: async (key?: string) => {
			const resolved = key?.trim() || portalKey();
			if (!resolved) throw new Error("没有 Portal API Key，请设置 LLM2_API_KEY");
			const catalog = await fetchCatalog(new AbortController().signal, resolved);
			return catalog.models;
		},
		oauth: {
			name: "BladeAI Portal API Key",
			async login(callbacks: { onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string> }) {
				const key = (await callbacks.onPrompt({
					message: "粘贴你的 BladeAI Portal API Key",
					placeholder: "sk-llm2-...",
				})).trim();
				if (!key) throw new Error("API Key 不能为空");
				return { refresh: key, access: key, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
			},
			async refreshToken(credentials: { refresh: string }) {
				return { refresh: credentials.refresh, access: credentials.refresh, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
			},
			getApiKey(credentials: { access: string }) { return credentials.access; },
		},
	} as any;

	if (isOMP) {
		pi.registerProvider(providerID, providerConfig);
	} else {
		const [{ createProvider }, { getApiProvider }] = await Promise.all([
			import("@earendil-works/pi-ai"),
			import("@earendil-works/pi-ai/compat"),
		]);
		let models: ModelConfig[] = [];
		const piStreams = getApiProvider("openai-completions");
		if (!piStreams) throw new Error("Pi 没有注册 openai-completions API");
		pi.registerProvider(createProvider({
			id: providerID,
			name: providerName,
			baseUrl: baseURL(),
			headers: { "X-App-Name": env("LLM2_APP_NAME", "pi-llm2") },
			auth: {
				apiKey: {
					name: "BladeAI Portal API Key",
					async login(interaction) {
						const key = (await interaction.prompt({
							type: "secret",
							message: "粘贴你的 BladeAI Portal API Key",
							placeholder: "sk-llm2-...",
						})).trim();
						if (!key) throw new Error("API Key 不能为空");
						return { type: "api_key" as const, key };
					},
					async resolve({ ctx, credential, signal }) {
						const key = credential?.key?.trim() || (await ctx.env("LLM2_API_KEY"))?.trim();
						signal.throwIfAborted();
						return key ? { auth: { apiKey: key, headers: { Authorization: `Bearer ${key}` } }, source: credential?.key ? "stored credential" : "LLM2_API_KEY" } : undefined;
					},
				},
			},
			models,
			async fetchModels(context) {
				if (!context.allowNetwork) return models;
				const key = portalKey(context.credential);
				if (!key) throw new Error("没有 Portal API Key，请运行 /login llm2 或设置 LLM2_API_KEY");
				models = (await fetchCatalog(context.signal, key)).models;
				return models.map(model => ({ ...model, provider: providerID, baseUrl: model.baseUrl ?? baseURL(), api: model.api ?? "openai-completions" })) as any;
			},
			api: piStreams,
		}));

	}
	registerTools(pi);
}
