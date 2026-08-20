import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

// Set when a key from the deleted block was moved into the credential store.
let keyMigrated = false;
// Set when a block was left in place because its key could not be moved.
let keyBlocked = false;
// The running client reads YAML but this runtime cannot parse it.
let yamlUnsupported = false;

function portalCredentialKey(credential?: CredentialLike): string | undefined {
	if (credential?.type === "oauth" && credential.access?.trim()) return credential.access.trim();
	if (credential?.type === "api_key" && credential.key?.trim()) return credential.key.trim();
	return undefined;
}

function portalKey(credential?: CredentialLike): string | undefined {
	const fromCredential = portalCredentialKey(credential);
	if (fromCredential) return fromCredential;
	// No cached host key: a credential removed by /logout must stop working
	// immediately, so callers resolve the live one themselves.
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
	const key = await keyFromRegistry(ctx);
	if (key) return key;
	// With a context the registry is the live credential source, so never fall
	// back to something it handed over earlier -- that would outlive /logout.
	return process.env.LLM2_API_KEY?.trim() || undefined;
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
	if (!providers || !Object.hasOwn(providers, providerID)) return null;

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

// Numeric literals outside string values. Scanning the raw text would also pick
// up digits inside strings -- a `"2026-08-20"` would look like the unpreservable
// literal `08` -- so track string state while walking.
function numericTokens(text: string): string[] {
	const tokens: string[] = [];
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (escaped) { escaped = false; continue; }
		if (ch === "\\") { escaped = inString; continue; }
		if (ch === '"') { inString = !inString; continue; }
		if (inString) continue;
		if (ch !== "-" && (ch < "0" || ch > "9")) continue;
		const token = /^-?\d[\d.]*(?:[eE][+-]?\d+)?/.exec(text.slice(i))?.[0];
		if (!token) continue;
		tokens.push(token);
		i += token.length - 1;
	}
	return tokens;
}

function purgeJSON(text: string, providerID: string): PurgeResult | null {
	// Re-serializing rewrites every number through Number, so any literal that
	// does not survive that trip unchanged -- past IEEE-754 exactness, or in
	// exponent/padded notation -- would come back altered in a provider this
	// cleanup never meant to touch. String(Number(x)) is JS's shortest
	// round-trip form, which is precisely what JSON.stringify emits.
	if (numericTokens(text).some(token => String(Number(token)) !== token)) return null;
	let parsed: ConfigShape;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const providers = providersOf(parsed);
	if (!providers || !Object.hasOwn(providers, providerID)) return null;
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

async function purgeConfigFile(
	file: string,
	providerID: string,
	isOMP: boolean,
	settleKey: (key: string) => Promise<boolean>,
): Promise<boolean> {
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
		if (text.includes(providerID)) yamlUnsupported = true;
		return false;
	}
	const purged = file.endsWith(".json") ? purgeJSON(text, providerID) : purgeYAML(text, providerID);
	if (purged === null) return false;

	// Follow symlinks before replacing anything: the managed original is what
	// the next dotfile sync would restore from.
	const target = resolveTarget(file);
	if (!target) return false;

	// Confirm the snapshot still stands *before* writing to the credential
	// store. Storing a key from a block that has since been rewritten would
	// make the new block look redundant on the next launch, and its replacement
	// key would be deleted while authentication stays pinned to the old one.
	try {
		if (readFileSync(target, "utf-8") !== text) return false;
	} catch {
		return false;
	}

	// Settle the key before touching the file. The block may hold the only copy,
	// and a client whose credential store cannot be written from here has no way
	// to get it back -- so leave the block in place rather than delete it.
	const key = purged.apiKey ? resolveKeyReference(purged.apiKey, isOMP) : undefined;
	if (key && !(await settleKey(key))) {
		keyBlocked = true;
		return false;
	}

	// Write a sibling and rename it into place: a direct write that fails
	// halfway -- a full disk right after the backup copy, most concretely --
	// would leave the live config truncated, which is exactly the damage this
	// cleanup exists to prevent. Rename within a directory is atomic.
	const temp = `${target}.llm2-tmp`;
	try {
		// Carry the original mode over: these files are commonly 0600 and the
		// rename would otherwise publish every provider's key to other users.
		writeSecretFile(temp, purged.text, statSync(target).mode & 0o777);
		// Checked again immediately before the rename, so the unguarded window is
		// just these two statements.
		if (readFileSync(target, "utf-8") !== text) {
			rmSync(temp, { force: true });
			return false;
		}
		// Back up last, so a mismatch above never leaves a backup of a file that
		// was not replaced.
		copyFileSync(target, `${target}${PURGE_BACKUP_SUFFIX}`);
		renameSync(temp, target);
	} catch {
		rmSync(temp, { force: true });
		return false;
	}
	return true;
}

// The host does not expose its resolved config path to extensions, so mirror
// the directory rules instead: PI_CODING_AGENT_DIR overrides the agent dir
// outright, otherwise the root is `~/<config dir>` plus, on Oh My Pi, the
// active profile. PI_CONFIG_DIR and profiles are Oh My Pi's own settings --
// it names a directory rather than a path, and the host joins it onto the home
// directory, so an absolute value lands under HOME there too.
//
// Only the file the running client actually reads is touched. Sweeping the
// other client's config as well would delete a block holding the only copy of
// its key -- that client cannot be authenticated from here, so its credential
// would survive only in a backup nothing reads back. Each client cleans up
// after itself on its own next launch.
function configPath(isOMP: boolean): string {
	// Bun caches os.homedir() at startup, so read $HOME first: it is what the
	// host itself resolves to, and it keeps the cleanup testable.
	const home = process.env.HOME?.trim() || homedir();
	const profile = isOMP ? (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim() : undefined;
	const configDir = (isOMP && process.env.PI_CONFIG_DIR?.trim()) || (isOMP ? ".omp" : ".pi");
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	const agentDir = override || join(home, configDir, ...(profile ? ["profiles", profile] : []), "agent");
	return join(agentDir, isOMP ? "models.yml" : "models.json");
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
async function purgeLegacyProvider(
	providerID: string,
	isOMP: boolean,
	settleKey: (key: string) => Promise<boolean>,
): Promise<string[]> {
	keyMigrated = false;
	keyBlocked = false;
	yamlUnsupported = false;
	const file = configPath(isOMP);
	return (await purgeConfigFile(file, providerID, isOMP, settleKey)) ? [file] : [];
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

type SessionContext = { ui?: { notify?(message: string, type?: string): void } };

// Pi's credential file. The registry it hands extensions exposes only readers
// -- no login(), no setter of any kind -- so a key can be moved there only by
// writing the file, the same way this extension already edits models.json.
// These files hold API keys, so the temp file must never exist in a readable
// mode: create it 0600 before writing (umask can only clear bits, never add
// them), then move it to the destination's own mode. Removing any leftover
// first matters -- writeFileSync does not apply `mode` to an existing file.
function writeSecretFile(temp: string, data: string, mode: number): void {
	rmSync(temp, { force: true });
	writeFileSync(temp, data, { mode: 0o600 });
	chmodSync(temp, mode);
}

// Dotfile managers link credential files too; renaming onto the link would
// swap it for a regular file and the managed original would never see the key.
// Undefined means the path cannot be written safely: a dangling link resolves
// to nothing, and writing there would destroy the link a later sync expects.
function resolveTarget(file: string): string | undefined {
	try {
		return realpathSync(file);
	} catch {
		try {
			if (lstatSync(file).isSymbolicLink()) return undefined;
		} catch {
			// Nothing at that path: it is its own target.
		}
		return file;
	}
}

function authPath(): string {
	return join(dirname(configPath(false)), "auth.json");
}

function readAuthKey(providerID: string): string | undefined {
	const file = authPath();
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, CredentialLike | undefined>;
		// Same shapes portalKey() accepts, so an oauth login counts as stored.
		return portalCredentialKey(parsed?.[providerID]);
	} catch {
		return undefined;
	}
}

function writeAuthKey(providerID: string, key: string): boolean {
	const target = resolveTarget(authPath());
	if (!target) return false;
	const entry = { type: "api_key", key };

	if (!existsSync(target)) {
		// Exclusive create rather than check-then-rename: another process (a
		// concurrent /login, say) may write auth.json while this one works, and
		// replacing it would throw away every credential it just stored. "wx"
		// fails instead, and the block is kept.
		try {
			writeFileSync(target, `${JSON.stringify({ [providerID]: entry }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
			return true;
		} catch {
			return false;
		}
	}

	const temp = `${target}.llm2-tmp`;
	try {
		const text = readFileSync(target, "utf-8");
		const parsed = JSON.parse(text) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		// An entry already exists but the caller could not read a usable key out
		// of it -- an oauth shape this extension does not know, or a broken value.
		// It is not ours to replace, and claiming success would let the caller
		// delete the block holding the only readable key. Report failure so the
		// block stays and the user is asked to sort the credential out.
		if (parsed[providerID] !== undefined) return false;
		parsed[providerID] = entry;
		writeSecretFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, statSync(target).mode & 0o777);
		if (readFileSync(target, "utf-8") !== text) {
			rmSync(temp, { force: true });
			return false;
		}
		renameSync(temp, target);
		return true;
	} catch {
		rmSync(temp, { force: true });
		return false;
	}
}

async function onSessionStart(providerID: string, purged: string[], ctx: SessionContext) {
	const notes: string[] = [];
	if (purged.length > 0) {
		notes.push(
			`已删除本地遗留的 ${providerID} provider 配置（${purged.join("、")}），扩展会自己注册该 provider，原文件备份为同名 ${PURGE_BACKUP_SUFFIX} 文件。`,
		);
		if (keyMigrated) notes.push("其中的 API Key 已存入凭据库，无需重新登录。");
	}
	if (keyBlocked) {
		notes.push(
			`检测到本地遗留的 ${providerID} provider 配置，其中的 API Key 还没有存入凭据库，删除会导致它丢失，所以暂时保留。请运行 /login ${providerID} 保存后重启，扩展会自动清理这段配置。`,
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
	// Resolve the host credential before anything else: on Oh My Pi this is the
	// only chance to publish models early enough for --model to resolve, and the
	// cleanup below must know whether a key it finds already has a home.
	const storage = isOMP ? await ompAuthStorage(pi) : undefined;
	let stored = isOMP ? await storedKey(storage, providerID) : readAuthKey(providerID);

	const purged = await purgeLegacyProvider(providerID, isOMP, async key => {
		// Already able to authenticate: the block's key is redundant, drop it.
		if (stored) return true;
		const moved = isOMP ? await storeKey(storage, providerID, key) : writeAuthKey(providerID, key);
		if (!moved) return false;
		keyMigrated = true;
		// It lives in the store now, so it is also the live credential for this
		// load -- the catalog fetch below still needs one.
		stored = key;
		return true;
	});
	// Pass the resolved value rather than "$LLM2_API_KEY": OMP treats apiKey
	// as an environment-variable name while Pi accepts interpolation syntax.
	// A literal resolved value works in both clients and remains in process memory.
	const apiKey = stored || portalKey();

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
			// Oh My Pi passes neither a credential nor a context here, so read the
			// live one from its store on every call. A snapshot taken at load time
			// would keep working after /logout.
			const resolved = key?.trim() || (await storedKey(await ompAuthStorage(pi), providerID)) || portalKey();
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
