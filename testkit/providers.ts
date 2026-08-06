/**
 * Provider configuration loading (10.2, 10.6).
 *
 * Keys come exclusively from environment variables; configs are exported with
 * values masked. Capabilities drive scenario selection, never model names.
 */
import type { ApiFormat } from "../src/formats.js";
import { isApiFormat } from "../src/formats.js";
import type { ProviderCapability, ProviderConfig } from "./types.js";

const CAPABILITIES: ProviderCapability[] = [
  "stream",
  "tools",
  "parallel_tools",
  "thinking",
  "chat_reasoning_extension",
];

export interface RawProviderConfig {
  id: string;
  protocol: string;
  baseUrl?: string;
  apiKeyEnv: string;
  model: string;
  capabilities: string[];
}

export function parseProviderConfig(raw: RawProviderConfig): ProviderConfig {
  if (!raw.id) throw new Error("provider id is required");
  if (!isApiFormat(raw.protocol)) {
    throw new Error(`provider "${raw.id}" has unknown protocol "${raw.protocol}"`);
  }
  if (!raw.apiKeyEnv) throw new Error(`provider "${raw.id}" requires apiKeyEnv`);
  if (!raw.model) throw new Error(`provider "${raw.id}" requires model`);
  const capabilities = raw.capabilities.filter((c): c is ProviderCapability =>
    CAPABILITIES.includes(c as ProviderCapability),
  );
  return {
    id: raw.id,
    protocol: raw.protocol as ApiFormat,
    baseUrl: resolveEnv(raw.baseUrl),
    apiKeyEnv: raw.apiKeyEnv,
    model: resolveEnv(raw.model) ?? "",
    capabilities,
  };
}

/** Resolve ${ENV_VAR} and ${ENV_VAR:default} placeholders. */
export function resolveEnv(template: string | undefined): string | undefined {
  if (template === undefined) return undefined;
  return template.replace(/\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g, (_, name: string, def?: string) => {
    return process.env[name] ?? def ?? "";
  });
}

export function providerApiKey(provider: ProviderConfig): string | undefined {
  return process.env[provider.apiKeyEnv] ?? undefined;
}

export function hasProviderKey(provider: ProviderConfig): boolean {
  return providerApiKey(provider) !== undefined;
}

/** Mask a key for logs/reports: keep first 4 chars, then asterisks. */
export function maskKey(key: string | undefined): string {
  if (!key) return "(unset)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.length} chars`;
}

export function describeProvider(provider: ProviderConfig): string {
  return `${provider.id} [${provider.protocol}] model=${provider.model} capabilities=${provider.capabilities.join(",")} key=${maskKey(providerApiKey(provider))}`;
}

/**
 * Built-in provider list (10.3): one Anthropic, one OpenAI native, one
 * third-party OpenAI-compatible. Live runs require the matching env keys.
 */
export const BUILTIN_PROVIDERS: RawProviderConfig[] = [
  {
    id: "anthropic-native",
    protocol: "anthropic-messages",
    baseUrl: "${ANTHROPIC_BASE_URL:https://api.anthropic.com}",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    model: "${ANTHROPIC_TEST_MODEL:claude-sonnet-4-5}",
    capabilities: ["stream", "tools", "parallel_tools", "thinking"],
  },
  {
    id: "openai-native",
    protocol: "openai-chat",
    baseUrl: "${OPENAI_BASE_URL:https://api.openai.com}",
    apiKeyEnv: "OPENAI_API_KEY",
    model: "${OPENAI_TEST_MODEL:gpt-4o-mini}",
    capabilities: ["stream", "tools", "parallel_tools", "chat_reasoning_extension"],
  },
  {
    id: "compatible-a",
    protocol: "openai-chat",
    baseUrl: "${COMPAT_A_BASE_URL}",
    apiKeyEnv: "COMPAT_A_API_KEY",
    model: "${COMPAT_A_MODEL}",
    capabilities: ["stream", "tools", "chat_reasoning_extension"],
  },
];

export function loadBuiltinProviders(): ProviderConfig[] {
  return BUILTIN_PROVIDERS.map(parseProviderConfig);
}
