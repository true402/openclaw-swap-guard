// true402 swap guard for OpenClaw: before any tool call that BUYS a token, check the token with
// true402 (an executed buy + sell simulation on Base / Ethereum / BSC, mint authorities on Solana)
// and block the call when the token is a honeypot or a rug in progress.
//
// One hook covers every trading skill and MCP tool the user has installed, so a skill the agent
// forgets to follow cannot skip the check. Only DANGER blocks; anything that could not be checked
// passes unless the user asks otherwise (see guard.ts).
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createGuard, type GuardConfig } from './guard.js';
import { createChecker, type CheckConfig } from './check.js';

type Config = GuardConfig & Omit<CheckConfig, 'payerPrivateKey'>;

const CHAINS = new Set(['base', 'ethereum', 'bsc']);

export function readConfig(raw: unknown): Config {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  return {
    defaultChain: CHAINS.has(c.defaultChain as string) ? (c.defaultChain as Config['defaultChain']) : undefined,
    onCaution: pick(c.onCaution, ['allow', 'ask'] as const),
    onUnchecked: pick(c.onUnchecked, ['allow', 'ask', 'block'] as const),
    allowTokens: Array.isArray(c.allowTokens) ? c.allowTokens.filter((x): x is string => typeof x === 'string') : undefined,
    timeoutMs: num(c.timeoutMs),
    maxAmountUsd: num(c.maxAmountUsd),
    maxPaidChecksPerDay: num(c.maxPaidChecksPerDay),
  };
}

export default definePluginEntry({
  id: 'true402-swap-guard',
  name: 'true402 swap guard',
  description: 'Blocks token buys when true402 finds a honeypot or a rug in progress (Base, Ethereum, BSC, Solana).',
  register(api) {
    const cfg = readConfig(api.pluginConfig);
    // A DEDICATED variable, read from the environment (never from plugin config, so it is not written
    // to OpenClaw's config file). Deliberately not the generic PAYER_PRIVATE_KEY: the guard must never
    // spend from a wallet key set for some other tool. Optional: without it only free checks run.
    const payerPrivateKey = process.env.TRUE402_PAYER_PRIVATE_KEY || undefined;
    const warn = (m: string) => (api.logger?.warn ? api.logger.warn(m) : console.warn(m));
    const guard = createGuard(createChecker({ ...cfg, payerPrivateKey }), { ...cfg, warn });
    api.on('before_tool_call', (event, ctx) => guard(event.toolName, event.params ?? {}, ctx?.abortSignal), { priority: 60 });
  },
});
