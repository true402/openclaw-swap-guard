// check.ts — ask true402 about one token and reduce the answer to a Verdict.
//
// EVM tokens: POST /v1/{chain}/token-report → verdict.rating avoid | caution | ok (an executed buy +
// sell simulation, deployer history, recent liquidity pulls). Solana mints: POST /v1/solana/token-safety
// → risk critical | high | medium | low. Without a payer key the call is a plain request, served by
// true402's small daily free allowance; with one, payStall pays the exact quoted price over x402
// (USDC on Base, never above the maxAmountUsd cap) whenever the free allowance is used up.
import { payStall } from './x402.js';
import { CLIENT } from './client.js';
import { clean, type Checker, type Verdict } from './guard.js';
import type { Chain, TradeTarget } from './detect.js';

export interface CheckConfig {
  /** A Base wallet key holding a little USDC. Optional: without it only free checks run. */
  payerPrivateKey?: string;
  /** Default https://true402.dev/api */
  baseUrl?: string;
  /** Give up after this many ms and treat the token as unchecked. Default 15000. */
  timeoutMs?: number;
  /** Never sign a single payment above this, in USDC. Default 0.25. */
  maxAmountUsd?: number;
}

interface EvmReport {
  verdict?: { rating?: string; reasons?: unknown };
  safety?: { flags?: unknown };
}
interface SolanaReport {
  risk?: string;
  flags?: unknown;
}

/** "Not a token here" is not danger: a wallet that slipped into a command, or a token on another chain. */
const NOT_A_TOKEN = new Set(['not_a_contract', 'mint_unreadable', 'mint_not_initialized']);
const SOL_NEVER_SELLABLE = new Set(['non_transferable', 'permanent_delegate']);
const SOL_SELL_BLOCKABLE = new Set(['freeze_authority_active', 'pausable', 'transfer_hook', 'default_frozen']);

export function evmVerdict(r: EvmReport, chain: string): Verdict {
  const flags = strings(r.safety?.flags);
  if (flags.some((f) => NOT_A_TOKEN.has(f))) return { level: 'unchecked', notToken: true, reasons: [`no token contract at this address on ${chain}`] };
  const reasons = strings(r.verdict?.reasons).map((s) => clean(s));
  switch (r.verdict?.rating) {
    case 'avoid': return { level: 'danger', reasons };
    case 'caution': return { level: 'caution', reasons };
    case 'ok': return { level: 'ok', reasons };
    default: return { level: 'unchecked', reasons: ['no verdict in the answer'] };
  }
}

export function solanaVerdict(r: SolanaReport): Verdict {
  const flags = strings(r.flags);
  if (flags.some((f) => NOT_A_TOKEN.has(f))) return { level: 'unchecked', notToken: true, reasons: ['not a token mint on solana'] };
  const reasons = flags.map((f) => clean(f.replace(/_/g, ' ')));
  // Can never be sold, or can be taken from you: danger whatever the score says.
  if (flags.some((f) => SOL_NEVER_SELLABLE.has(f))) return { level: 'danger', reasons };
  // An issuer who can stop your sell (freeze — "the Solana honeypot" — pause, transfer hook). Legit
  // tokens carry these too, so it blocks only when the overall risk is already high; else caution.
  const canStopSell = flags.some((f) => SOL_SELL_BLOCKABLE.has(f));
  switch (r.risk) {
    case 'critical': return { level: 'danger', reasons };
    case 'high': return { level: canStopSell ? 'danger' : 'caution', reasons };
    case 'medium': return { level: canStopSell ? 'caution' : 'ok', reasons };
    case 'low': return { level: canStopSell ? 'caution' : 'ok', reasons };
    default: return { level: 'unchecked', reasons: ['no risk level in the answer'] };
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function createChecker(cfg: CheckConfig = {}): Checker {
  const baseUrl = cfg.baseUrl ?? 'https://true402.dev/api';
  const timeoutMs = cfg.timeoutMs ?? 15_000;

  async function ask(path: string, token: string): Promise<unknown> {
    if (cfg.payerPrivateKey) {
      return payStall(path, { token }, { payerPrivateKey: cfg.payerPrivateKey, baseUrl, maxAmountUsd: cfg.maxAmountUsd });
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `true402-${CLIENT.id}/${CLIENT.version} (+https://true402.dev)` },
      body: JSON.stringify({ token }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 402) throw new Error('the free daily checks are used up — set PAYER_PRIVATE_KEY to pay per check');
    if (!res.ok) throw new Error(`true402 answered HTTP ${res.status}`);
    return res.json();
  }

  return async (t: TradeTarget & { chain: Chain }) => {
    const path = t.chain === 'solana' ? '/v1/solana/token-safety' : `/v1/${t.chain}/token-report`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const body = await Promise.race([ask(path, t.token), deadline]);
      return t.chain === 'solana' ? solanaVerdict(body as SolanaReport) : evmVerdict(body as EvmReport, t.chain);
    } finally {
      clearTimeout(timer);
    }
  };
}
