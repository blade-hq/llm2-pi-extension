import {
	chmodSync,
	copyFileSync,
	existsSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_BASE_URL = "https://llm2.yangl.com.cn/v1";
const DEFAULT_PROVIDER_ID = "llm2";
const DEFAULT_PROVIDER_NAME = "BladeAI LLM2";
const CATALOG_TIMEOUT_MS = 30_000;
const OMP_STARTUP_CATALOG_TIMEOUT_MS = 3_000;

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

// Oh My Pi calls fetchDynamicModels() without a credential and without a
// context, so a key the host already has would otherwise be invisible to the
// catalog refresh. Both clients hand the extension a context at session_start;
// cache what it resolves there and fall back to it afterwards.
let hostKey: string | undefined;
// An api key read out of a provider block just before it was deleted.
let rescuedKey: string | undefined;
// Whether that key made it into the host's credential store.
let rescueStored = false;
// The running client reads YAML but this runtime cannot parse it.
let yamlUnsupported = false;

function portalKey(credential?: CredentialLike): string | undefined {
	if (credential?.type === "oauth" && credential.access?.trim()) return credential.access.trim();
	if (credential?.type === "api_key" && credential.key?.trim()) return credential.key.trim();
	return process.env.LLM2_API_KEY?.trim() || hostKey || rescuedKey;
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

async function fetchCatalog(signal: AbortSignal | undefined, key: string): Promise<CatalogResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
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
		signal?.removeEventListener("abort", onAbort);
	}
}

// Only consults the host's credential store, so callers can tell a key the
// host has already persisted from one this extension is carrying in memory.
async function keyFromRegistry(ctx: { modelRegistry?: unknown }): Promise<string | undefined> {
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
	return undefined;
}

async function keyFromContext(ctx: { modelRegistry?: unknown }): Promise<string | undefined> {
	return (await keyFromRegistry(ctx)) ?? portalKey();
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

const PURGE_BACKUP_SUFFIX = ".llm2-purged.bak";

// Remove a top-level `providers.<id>` block while leaving the rest of the file
// byte-identical. Returns null when there is nothing to remove, so the caller
// never rewrites a file it does not need to touch.
type PurgeResult = { text: string; apiKey?: string };

// YAML keys may be quoted; compare against the bare text.
function unquote(value: string): string {
	return value.replace(/^["']|["']$/g, "");
}

type Providers = Record<string, { apiKey?: unknown } | null>;
type ConfigShape = { providers?: unknown };

// A malformed file can hold anything under `providers` -- `providers: disabled`
// parses to a string. Without this check the `in` test below throws and takes
// the whole extension down, which is worse than the stale block it came for.
function providersOf(parsed: ConfigShape | undefined): Providers | undefined {
	const providers = parsed?.providers;
	return providers && typeof providers === "object" && !Array.isArray(providers)
		? (providers as Providers)
		: undefined;
}

// Oh My Pi runs on Bun (its own engines field requires >=1.3.14, which ships
// Bun.YAML) and is the client that reads models.yml; Pi runs on Node and reads
// models.json. Without a parser this extension will not edit YAML at all: a
// hand-rolled parse cannot be trusted to leave a working file working, and a
// broken models.yml takes every provider down with it.
function yamlParser(): { parse(text: string): unknown } | undefined {
	return (globalThis as { Bun?: { YAML?: { parse(text: string): unknown } } }).Bun?.YAML;
}

function parseYAML(text: string): ConfigShape | undefined {
	const yaml = yamlParser();
	if (!yaml) return undefined;
	try {
		const parsed = yaml.parse(text);
		return parsed && typeof parsed === "object" ? (parsed as ConfigShape) : undefined;
	} catch {
		return undefined;
	}
}

// Line-level edit so comments, indentation style and trailing whitespace in the
// rest of the file survive. Bun.YAML.stringify() would round-trip the document
// into one flow-style line, which is a worse outcome than a stale block.
function removeYAMLBlock(text: string, providerID: string): string | null {
	const lines = text.split("\n");
	// The value must be empty (a block mapping follows), but an inline comment
	// may sit after the colon.
	const root = lines.findIndex(line => /^["']?providers["']?\s*:\s*(#.*)?$/.test(line));
	if (root < 0) return null;

	const isSkippable = (line: string) => !line.trim() || line.trim().startsWith("#");

	let start = -1;
	let baseIndent: string | null = null;
	for (let i = root + 1; i < lines.length; i++) {
		const line = lines[i];
		if (isSkippable(line)) continue;
		// Only a top-level key ends the providers mapping. Everything indented
		// belongs to some provider -- including sequence items like `- id: x`,
		// which match no key pattern; stopping at those would hide any provider
		// listed after one that spells out its models.
		if (!/^\s/.test(line)) break;
		const entry = /^(\s+)([^\s:]+)\s*:/.exec(line);
		if (!entry) continue;
		if (baseIndent === null) baseIndent = entry[1];
		if (entry[1] !== baseIndent) continue;
		if (unquote(entry[2]) === providerID) { start = i; break; }
	}
	if (start < 0 || baseIndent === null) return null;

	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		// Comments belong to the block, not to its end: treating an unindented
		// comment as the terminator would delete only the first half of the
		// block and leave its remaining properties dangling.
		if (isSkippable(lines[i])) continue;
		if ((/^\s*/.exec(lines[i]) as RegExpExecArray)[0].length <= baseIndent.length) { end = i; break; }
	}
	// Give trailing comments and blank lines back to whatever follows.
	while (end > start + 1 && isSkippable(lines[end - 1])) end--;

	const kept = [...lines.slice(0, start), ...lines.slice(end)];
	// A bare `providers:` with no children parses as null and fails the same
	// schema check this cleanup exists to prevent. Stop at the next top-level
	// key: entries under a later section such as `aliases:` are not providers.
	let survivor = false;
	for (let i = root + 1; i < kept.length && !survivor; i++) {
		const line = kept[i];
		if (isSkippable(line)) continue;
		if (!/^\s/.test(line)) break;
		const entry = /^(\s+)[^\s:]+\s*:/.exec(line);
		survivor = entry?.[1] === baseIndent;
	}
	if (!survivor) {
		// Insert `{}` in place, keeping the key's own spelling and any inline
		// comment: those belong to the surviving `providers` key, not to the
		// block being removed. Verification would not catch their loss, since
		// YAML parsing ignores comments.
		const rootLine = kept[root];
		const comment = /\s(#.*)$/.exec(rootLine)?.[1];
		const key = rootLine.slice(0, rootLine.indexOf(":") + 1);
		kept[root] = comment ? `${key} {} ${comment}` : `${key} {}`;
	}
	const result = kept.join("\n");
	// Dropping a trailing block also drops the file's final newline.
	return text.endsWith("\n") && !result.endsWith("\n") ? `${result}\n` : result;
}

// The parser decides what is there and what the edit must produce; the line
// edit only supplies the formatting. Anything the edit cannot express exactly
// -- an unrecognized spelling, a comment layout that shifts a boundary -- fails
// this check and the file is left alone rather than rewritten into something
// the client cannot load.
function purgeYAML(text: string, providerID: string): PurgeResult | null {
	const before = parseYAML(text);
	const providers = providersOf(before);
	if (!providers || !(providerID in providers)) return null;

	const edited = removeYAMLBlock(text, providerID);
	if (edited === null) return null;

	const expected = { ...before, providers: { ...providers } };
	delete expected.providers[providerID];
	if (JSON.stringify(parseYAML(edited)) !== JSON.stringify(expected)) return null;

	const apiKey = providers[providerID]?.apiKey;
	return {
		text: edited,
		apiKey: typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined,
	};
}

function purgeJSON(text: string, providerID: string): PurgeResult | null {
	// A round trip through Number would silently rewrite integers past 2^53 --
	// 9007199254740993 comes back as ...992 -- in providers this cleanup never
	// meant to touch. 16 digits is the shortest length that can exceed it.
	if (/\d{16,}/.test(text)) return null;
	let parsed: ConfigShape;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const providers = providersOf(parsed);
	if (!providers || !(providerID in providers)) return null;
	const apiKey = providers[providerID]?.apiKey;
	delete providers[providerID];
	// Re-serializing loses the original layout, so follow the file's own
	// indentation and final-newline style. Key order survives JSON.stringify.
	const indent = /\n([ \t]+)/.exec(text)?.[1];
	const serialized = indent ? JSON.stringify(parsed, null, indent) : JSON.stringify(parsed);
	return {
		text: text.endsWith("\n") ? `${serialized}\n` : serialized,
		apiKey: typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined,
	};
}

function purgeConfigFile(file: string, providerID: string, activeFile: string, isOMP: boolean): boolean {
	if (!existsSync(file)) return false;
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return false;
	}
	if (!file.endsWith(".json") && !yamlParser()) {
		// Say so rather than skipping quietly, but only for the file this client
		// actually reads: another client's models.yml is its own to clean up.
		if (file === activeFile && text.includes(providerID)) yamlUnsupported = true;
		return false;
	}
	const purged = file.endsWith(".json") ? purgeJSON(text, providerID) : purgeYAML(text, providerID);
	if (purged === null) return false;
	// Write a sibling and rename it into place: a direct write that fails
	// halfway -- a full disk right after the backup copy, most concretely --
	// would leave the live config truncated, which is exactly the damage this
	// cleanup exists to prevent. Rename within a directory is atomic.
	// Follow symlinks before replacing anything: dotfile managers commonly link
	// these paths, and renaming onto the link would swap it for a regular file,
	// silently breaking that setup while the managed original keeps the stale
	// block -- which the next sync would restore.
	let target = file;
	try {
		target = realpathSync(file);
	} catch {
		// Unreadable link: fall back to the path as given.
	}
	const temp = `${target}.llm2-tmp`;
	try {
		// These files hold API keys for every provider, and are commonly mode
		// 0600. A fresh temp file would land on 0644 under the usual umask and
		// the rename would publish the whole config to other local users, so
		// carry the original mode over. chmod after the write: the `mode` option
		// is masked by the umask, an explicit chmod is not.
		const mode = statSync(target).mode & 0o777;
		copyFileSync(target, `${target}${PURGE_BACKUP_SUFFIX}`);
		writeFileSync(temp, purged.text);
		chmodSync(temp, mode);
		renameSync(temp, target);
	} catch {
		rmSync(temp, { force: true });
		return false;
	}
	// The deleted block may have been the only place the key lived. Keep it so
	// the session stays usable and the key can be moved into the credential
	// store once a context is available.
	if (purged.apiKey && file === activeFile) rescuedKey = resolveKeyReference(purged.apiKey, isOMP);
	return true;
}

// The host does not expose its resolved config path to extensions, so mirror
// the directory rules instead: PI_CONFIG_DIR renames the root, a profile moves
// it under profiles/<name>/, and PI_CODING_AGENT_DIR overrides the agent dir
// outright.
//
// `active` is the single file the running client actually reads; `sweep` also
// covers the other client and the inactive profile/root variants. Deleting from
// all of them is safe -- a stale block only ever breaks the client that reads
// it -- but a credential may only be taken from `active`, because that is the
// one whose key this client would otherwise have authenticated with.
function configPaths(isOMP: boolean): { active: string; sweep: string[] } {
	// Bun caches os.homedir() at startup, so read $HOME first: it is what the
	// host itself resolves to, and it keeps the cleanup testable.
	const home = process.env.HOME?.trim() || homedir();
	// Profiles are an Oh My Pi feature -- Pi reads neither variable, so its
	// active path must not shift because OMP_PROFILE happens to be exported.
	// Oh My Pi's own rule is OMP_PROFILE when defined, otherwise PI_PROFILE.
	const sweepProfile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim();
	const profile = isOMP ? sweepProfile : undefined;
	// PI_CONFIG_DIR is likewise Oh My Pi's alone, and it names a directory
	// rather than a path -- the host joins it onto the home directory, so an
	// absolute value lands under HOME there too. Pi never reads it.
	const sweepConfigDir = process.env.PI_CONFIG_DIR?.trim();
	const configDir = (isOMP ? sweepConfigDir : undefined) || (isOMP ? ".omp" : ".pi");
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	const profileSegments = profile ? ["profiles", profile] : [];

	const activeDir = override || join(home, configDir, ...profileSegments, "agent");
	const active = join(activeDir, isOMP ? "models.yml" : "models.json");

	const dirs = new Set<string>([activeDir]);
	for (const name of new Set([configDir, sweepConfigDir, ".omp", ".pi"])) {
		if (!name) continue;
		dirs.add(join(home, name, "agent"));
		// Sweep the profile variants regardless of client: deleting a stale block
		// is safe anywhere, only the credential must come from `active`.
		if (sweepProfile) dirs.add(join(home, name, "profiles", sweepProfile, "agent"));
	}
	const sweep = new Set<string>();
	for (const dir of dirs) {
		sweep.add(join(dir, "models.yml"));
		sweep.add(join(dir, "models.json"));
	}
	return { active, sweep: [...sweep] };
}

// Oh My Pi reads `apiKey` as the name of an environment variable and Pi accepts
// $NAME / ${NAME} interpolation, so the field is not necessarily a secret.
// Storing the reference text verbatim would put an unusable value in the
// credential store, which only surfaces on a later launch without that variable
// set -- after the working block is already gone. Resolve references, and skip
// the migration when one resolves to nothing.
function resolveKeyReference(value: string, isOMP: boolean): string | undefined {
	const interpolated = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value);
	if (interpolated) return process.env[interpolated[1]]?.trim() || undefined;
	// The bare-name form is Oh My Pi's alone -- in Pi the same spelling is a
	// literal key, and treating it as a reference would discard a usable one.
	if (!isOMP) return value;
	// Env names are case-sensitive, so do not restrict the spelling: look the
	// value up as written. Failing that, decide by shape -- something that could
	// be an env name is an unset reference and must not be stored, while a
	// spelling no env name can have (`sk-…`, dots, slashes) is a literal key.
	const resolved = process.env[value]?.trim();
	if (resolved) return resolved;
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? undefined : value;
}

// A hand-written provider block shadows the one this extension registers, and a
// half-written one (`models:` with no value) fails schema validation and takes
// the whole config file down with it -- every other provider in the file stops
// resolving. Clearing it on startup keeps registration the single source.
function purgeLegacyProvider(providerID: string, isOMP: boolean): string[] {
	rescuedKey = undefined;
	rescueStored = false;
	yamlUnsupported = false;
	const { active, sweep } = configPaths(isOMP);
	return sweep.filter(file => purgeConfigFile(file, providerID, active, isOMP));
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

type AuthStorageLike = {
	peekApiKey?(providerID: string): Promise<string | undefined> | string | undefined;
	set?(providerID: string, credential: { type: string; key: string }): Promise<void> | void;
};

// Oh My Pi exposes its credential store on the extension api itself, which is
// reachable at load time -- early enough to seed the catalog before the host
// resolves --model. Pi has no equivalent at load time and goes through
// modelRegistry at session_start instead.
async function ompAuthStorage(pi: unknown): Promise<AuthStorageLike | undefined> {
	const ns = (pi as { pi?: { discoverAuthStorage?: () => Promise<AuthStorageLike> } }).pi;
	if (typeof ns?.discoverAuthStorage !== "function") return undefined;
	try {
		return await ns.discoverAuthStorage();
	} catch {
		return undefined;
	}
}

async function storedKey(storage: AuthStorageLike | undefined, providerID: string): Promise<string | undefined> {
	try {
		const key = await storage?.peekApiKey?.(providerID);
		return typeof key === "string" && key.trim() ? key.trim() : undefined;
	} catch {
		return undefined;
	}
}

async function storeKey(storage: AuthStorageLike | undefined, providerID: string, key: string): Promise<boolean> {
	if (typeof storage?.set !== "function") return false;
	try {
		await storage.set(providerID, { type: "api_key", key });
		return true;
	} catch {
		return false;
	}
}

type SessionContext = {
	ui?: { notify?(message: string, type?: string): void };
	modelRegistry?: unknown;
};

// Move a rescued key into the host's credential store so it survives the
// deletion. This is the Pi path -- Oh My Pi stores the key at load time,
// before the catalog fetch that needs it.
async function persistRescuedKey(providerID: string, ctx: SessionContext): Promise<boolean> {
	const key = rescuedKey;
	const registry = ctx.modelRegistry as
		| { login?: (provider: string, type: string, interaction: unknown) => Promise<unknown> }
		| undefined;
	if (!key || typeof registry?.login !== "function") return false;
	// The provider registers an oauth-shaped flow, but ask for the api_key form
	// too: which one a host offers depends on how it composed the provider.
	for (const type of ["oauth", "api_key"]) {
		try {
			await registry.login(providerID, type, { prompt: async () => key, notify: () => {} });
			hostKey = key;
			return true;
		} catch {
			// Try the next credential type.
		}
	}
	return false;
}

async function onSessionStart(providerID: string, purged: string[], ctx: SessionContext) {
	const key = await keyFromRegistry(ctx).catch(() => undefined);
	if (key) hostKey = key;
	if (rescuedKey && !rescueStored && !key) rescueStored = await persistRescuedKey(providerID, ctx);

	const notes: string[] = [];
	if (purged.length > 0) {
		notes.push(
			`已删除本地遗留的 ${providerID} provider 配置（${purged.join("、")}），扩展会自己注册该 provider，原文件备份为同名 ${PURGE_BACKUP_SUFFIX} 文件。`,
		);
	}
	if (rescuedKey) {
		notes.push(
			rescueStored
				? "其中的 API Key 已存入凭据库，无需重新登录。"
				: `其中的 API Key 本次会话仍然可用，但没能写入凭据库，请运行 /login ${providerID} 永久保存。`,
		);
	}
	if (yamlUnsupported) {
		notes.push(
			`本地配置里还有遗留的 ${providerID} provider 配置，但当前运行时没有 YAML 解析器（需要 Bun 1.3.14 及以上），无法安全清理，请升级后重启或手动删除该配置块。`,
		);
	}
	if (notes.length > 0) ctx.ui?.notify?.(notes.join(""), "warning");
}

export default async function bladeAIExtension(pi: ExtensionAPI) {
	const isOMP = "pi" in (pi as unknown as Record<string, unknown>);
	const providerID = env("LLM2_PROVIDER_ID", DEFAULT_PROVIDER_ID);
	const providerName = env("LLM2_PROVIDER_NAME", DEFAULT_PROVIDER_NAME);
	const purged = purgeLegacyProvider(providerID, isOMP);

	// Read the host credential before building the provider config: on Oh My Pi
	// this is the only chance to publish models early enough for --model to
	// resolve, and it is where a rescued key has to land to survive the purge.
	const storage = await ompAuthStorage(pi);
	hostKey = await storedKey(storage, providerID);
	if (rescuedKey && !hostKey) rescueStored = await storeKey(storage, providerID, rescuedKey);
	// Pass the resolved value rather than "$LLM2_API_KEY": OMP treats apiKey
	// as an environment-variable name while Pi accepts interpolation syntax.
	// A literal resolved value works in both clients and remains in process memory.
	const apiKey = portalKey();

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

	// Seed Oh My Pi's synchronous model list so --model resolves during startup;
	// its dynamic discovery runs too late for that. Register exactly once:
	// a second registration replaces the first, so re-registering without models
	// would throw the catalog away and leave every llm2 model unresolvable.
	let initialModels: ModelConfig[] | undefined;
	if (isOMP && apiKey) {
		try {
			initialModels = (await fetchCatalog(AbortSignal.timeout(OMP_STARTUP_CATALOG_TIMEOUT_MS), apiKey)).models;
		} catch {
			// Portal unreachable at startup: the host's cached catalog still applies.
		}
	}
	// Use the config-form provider on both clients. createProvider() from a
	// locally installed pi-ai can disagree with the host Pi about the refresh
	// context (store vs publish) and abort the /model catalog update.
	pi.registerProvider(providerID, initialModels?.length ? { ...providerConfig, models: initialModels } : providerConfig);
	registerTools(pi);

	const host = pi as unknown as {
		on?(event: string, handler: (event: unknown, ctx: SessionContext) => Promise<void>): void;
	};
	if (typeof host.on === "function") {
		host.on("session_start", (_event, ctx) => onSessionStart(providerID, purged, ctx));
	}
}
