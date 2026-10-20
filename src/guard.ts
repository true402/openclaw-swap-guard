// guard.ts — turn true402 verdicts into an OpenClaw before_tool_call decision.
//
// The rule that keeps this safe to install: a trade is BLOCKED only on a definite danger verdict
// (EVM rating "avoid", Solana risk "critical"). Anything we could not establish — our API down, the
// free allowance used up, the address is a wallet not a token, a chain mismatch — lets the trade
// through by default (onUnchecked), because a guard that breaks every swap when a third party
// hiccups gets uninstalled, and then it protects nobody.
import { detectTrade, type Chain, type TradeTarget } from './detect.js';

export interface Verdict {
  /** 'danger' blocks; 'caution' may ask; 'ok' passes; 'unchecked' = could not establish. */
  level: 'danger' | 'caution' | 'ok' | 'unchecked';
  /** Short reasons, already stripped of control characters. */
  reasons: string[];
  /** 'unchecked' only because there is no token at this address on that chain (wrong chain / a wallet). */
  notToken?: boolean;
}

export type Checker = (t: TradeTarget & { chain: Chain }, signal?: AbortSignal) => Promise<Verdict>;

export interface GuardConfig {
  /** Chain assumed for an EVM address when the call names none. Default 'base'. */
  defaultChain?: Exclude<Chain, 'solana'>;
  /** On a 'caution' verdict: 'allow' (default) or 'ask' the user. */
  onCaution?: 'allow' | 'ask';
  /** When no verdict could be had: 'allow' (default), 'ask', or 'block'. */
  onUnchecked?: 'allow' | 'ask' | 'block';
  /** Token addresses (any chain) never checked — your own tokens, or ones you accept. */
  allowTokens?: string[];
  /** How long one verdict is reused, in ms. Default 10 minutes. */
  cacheMs?: number;
  /**
   * Told when a token could not be checked, at most once per reason every 10 minutes. Without it a
   * guard whose free checks ran out would wave every trade through without anyone knowing.
   */
  warn?: (message: string) => void;
}

export interface HookResult {
  block?: boolean;
  blockReason?: string;
  requireApproval?: { title: string; description: string; severity?: 'info' | 'warning' | 'critical'; timeoutMs?: number };
}

/** At most this many checks per call; any further token is reported as unchecked, never dropped. */
const MAX_TOKENS = 5;

export function createGuard(check: Checker, cfg: GuardConfig = {}, now: () => number = Date.now) {
  const cacheMs = cfg.cacheMs ?? 10 * 60_000;
  const allow = new Set((cfg.allowTokens ?? []).map((a) => a.toLowerCase()));
  const cache = new Map<string, { at: number; v: Verdict }>();
  const warned = new Map<string, number>();
  const warnOnce = (why: string) => {
    if (!cfg.warn) return;
    const last = warned.get(why);
    if (last !== undefined && now() - last < 10 * 60_000) return;
    warned.set(why, now());
    cfg.warn(`true402 swap guard: a token could not be checked (${why}); the trade was ${cfg.onUnchecked === 'block' ? 'blocked' : cfg.onUnchecked === 'ask' ? 'held for approval' : 'allowed unchecked'}.`);
  };

  async function verdict(t: TradeTarget & { chain: Chain }, signal?: AbortSignal): Promise<Verdict> {
    const key = `${t.chain}:${t.token.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.v;
    let v: Verdict;
    try {
      v = await check(t, signal);
    } catch (e) {
      v = { level: 'unchecked', reasons: [clean(e instanceof Error ? e.message : String(e))] };
    }
    // Never cache "unchecked": the next call may get through (allowance reset, API back).
    if (v.level !== 'unchecked') cache.set(key, { at: now(), v });
    return v;
  }

  return async function beforeToolCall(toolName: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<HookResult | undefined> {
    const targets = detectTrade(toolName, params, cfg.defaultChain ?? 'base').filter((t) => !allow.has(t.token.toLowerCase()));
    if (!targets.length) return undefined;

    // One token can be listed on several chains (the default chain is always among them). Results are
    // combined PER TOKEN: a real verdict on any chain counts, and "not a token here" from the other
    // chains is ignored. The cap counts distinct tokens; more than that is never waved through.
    const byToken = new Map<string, TradeTarget[]>();
    for (const t of targets) {
      const k = t.token.toLowerCase();
      byToken.set(k, [...(byToken.get(k) ?? []), t]);
    }
    const groups = [...byToken.values()];
    if (groups.length > MAX_TOKENS) {
      const why = `this call names ${groups.length} tokens; the guard checks at most ${MAX_TOKENS} per call`;
      warnOnce(why);
      if (cfg.onUnchecked === 'block') return { block: true, blockReason: `true402 swap guard blocked this trade: ${why}.` };
      return { requireApproval: { title: 'Too many tokens to check — confirm the trade', description: `${why}.`, severity: 'warning' } };
    }
    const results = await Promise.all(
      groups.map(async (ts) => {
        const vs = await Promise.all(
          ts.map((t) => (t.chain === 'unsupported' ? Promise.resolve<Verdict>({ level: 'unchecked', reasons: ['a chain true402 does not serve'] }) : verdict(t as TradeTarget & { chain: Chain }, signal))),
        );
        const pick = (level: Verdict['level']) => vs.findIndex((x) => x.level === level);
        if (pick('danger') >= 0) return { t: ts[pick('danger')], v: vs[pick('danger')] };
        // The call names a chain we do not serve: a clean verdict for the same address on ANOTHER
        // chain says nothing about the token being traded. Only danger counts then.
        const u = ts.findIndex((t) => t.chain === 'unsupported');
        if (u >= 0) return { t: ts[u], v: vs[u] };
        // Only "no token at this address on that chain" may be set aside for another chain's verdict.
        // Any other failure (API down, allowance used up) keeps the token unchecked: a clean result on
        // a different chain must never stand in for a check that did not happen.
        const failed = vs.findIndex((x) => x.level === 'unchecked' && !x.notToken);
        if (failed >= 0) return { t: ts[failed], v: vs[failed] };
        for (const level of ['caution', 'ok'] as const) {
          const i = pick(level);
          if (i >= 0) return { t: ts[i], v: vs[i] };
        }
        return { t: ts[0], v: { level: 'unchecked', reasons: [...new Set(vs.flatMap((x) => x.reasons))] } as Verdict };
      }),
    );
    const danger = results.find((r) => r.v.level === 'danger');
    if (danger) {
      return {
        block: true,
        blockReason:
          `true402 swap guard blocked this trade: ${danger.t.token} on ${danger.t.chain} was rated dangerous` +
          `${reasonText(danger.v)}. Do not retry it with another tool. To trade it anyway, add the address to ` +
          `the plugin's allowTokens setting.`,
      };
    }

    const caution = results.find((r) => r.v.level === 'caution');
    if (caution && cfg.onCaution === 'ask') {
      return {
        requireApproval: {
          title: 'Risky token — confirm the trade',
          description: `true402 rated ${caution.t.token} on ${caution.t.chain} "caution"${reasonText(caution.v)}.`,
          severity: 'warning',
        },
      };
    }

    const unchecked = results.find((r) => r.v.level === 'unchecked');
    if (unchecked) warnOnce(unchecked.v.reasons[0] ?? 'unknown');
    if (unchecked && cfg.onUnchecked && cfg.onUnchecked !== 'allow') {
      const why = `true402 could not check ${unchecked.t.token} on ${unchecked.t.chain}${reasonText(unchecked.v)}.`;
      if (cfg.onUnchecked === 'block') return { block: true, blockReason: `true402 swap guard blocked this trade: ${why}` };
      return { requireApproval: { title: 'Unchecked token — confirm the trade', description: why, severity: 'info' } };
    }
    return undefined;
  };
}

function reasonText(v: Verdict): string {
  return v.reasons.length ? ` (${v.reasons.slice(0, 4).join('; ')})` : '';
}

/** Server and error text goes in front of a model and a user: no control characters, bounded length. */
export function clean(s: string, max = 160): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
