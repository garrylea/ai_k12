import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import type { ModelConfig, RetryOptions } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadYaml<T>(filename: string): T {
  const raw = readFileSync(resolve(__dirname, filename), 'utf-8');
  // Inject environment variables: ${VAR_NAME} -> process.env value
  const interpolated = raw.replace(/\$\{(\w+)\}/g, (_, name) => {
    const value = process.env[name];
    if (!value) {
      console.warn(`[config] Environment variable ${name} not set`);
      return '';
    }
    return value;
  });
  return yaml.load(interpolated) as T;
}

interface RouteRule {
  subject: string;
  difficulty?: number[];
  primary: string;
  fallback?: string | null;
}

interface RouteConfig {
  routes: Record<string, RouteRule[]>;
  models: Record<string, ModelConfig & { apiKey: string }>;
  default: { primary: string; fallback: string };
}

interface TimeoutConfig {
  retry: RetryOptions;
  timeout: Record<string, number>;
  streaming: { firstTokenTimeoutMs: number; interTokenTimeoutMs: number };
}

interface SafetyConfig {
  safety: {
    classifier: { model: string; confidenceThreshold: number };
    off_topic: { escalateThreshold: number; criticalThreshold: number };
    anomaly: { types: Record<string, { alertLevel: string; block: boolean }> };
    gentleBlock: { randomPick: boolean };
  };
}

interface FallbackConfig {
  fallback: {
    consecutiveFailThreshold: number;
    giveUpKeywords: string[];
    outputStructure: string[];
  };
}

export const routeConfig = loadYaml<RouteConfig>('model-routes.yaml');
export const timeoutConfig = loadYaml<TimeoutConfig>('retry.yaml');
export const safetyConfig = loadYaml<SafetyConfig>('safety.yaml');
export const fallbackConfig = loadYaml<FallbackConfig>('fallback.yaml');

export function getModelConfig(modelId: string): ModelConfig {
  const model = routeConfig.models[modelId];
  if (!model) throw new Error(`Unknown model: ${modelId}`);
  const { apiKey, ...rest } = model;
  return rest;
}

export function getModelApiKey(modelId: string): string {
  const model = routeConfig.models[modelId];
  if (!model) throw new Error(`Unknown model: ${modelId}`);
  return model.apiKey;
}

// Look up apiKey by provider name. routeConfig.models is keyed by modelId,
// but ModelClient.getProvider is keyed by provider; this scans for the first
// model entry matching the provider and returns its apiKey.
export function getApiKeyByProvider(provider: string): string {
  for (const cfg of Object.values(routeConfig.models)) {
    if (cfg.provider === provider) return cfg.apiKey ?? '';
  }
  throw new Error(`No model configured for provider: ${provider}`);
}

export { __dirname as templateBasePath };
