// detect.ts — does this tool call BUY a token, and which one, on which chain?
//
// Pure: no network, no OpenClaw import, so every rule here is unit-tested. The guard (guard.ts) only
// asks true402 about what this file returns, so a false positive costs one check and a false negative
// lets one trade through unchecked — neither ever blocks a trade by itself. Blocking needs a verdict.

export type Chain = 'base' | 'ethereum' | 'bsc' | 'solana';

export interface TradeTarget {
  /** 'unsupported' = the call names a chain true402 does not serve: reported, never guessed. */
  chain: Chain | 'unsupported';
  token: string;
}

const EVM_ADDRESS = /0x[a-fA-F0-9]{40}\b/g;
// Base58, 32–44 characters: a Solana mint. Only trusted where a parameter or flag NAMES a token —
// free text is full of wallet addresses and signatures that match the same alphabet.
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Words that mean "this call acquires a token". */
const TRADE_VERB = /\b(swap|swaps|buy|buys|trade|snipe|ape|purchase|enter|market-buy|limit-buy)\b|tradr-enter|--token-out|--output-mint|--buy-token/i;
/** Tool names that trade without an exec command line (MCP tools, plugin tools). */
const TRADE_TOOL = /(swap|buy|trade|snipe|purchase|order)/i;

/** Parameter / flag names that hold the token being RECEIVED. Checked first. */
const OUT_KEYS = ['tokenout', 'token_out', 'outputmint', 'output_mint', 'outputtoken', 'output_token', 'totoken', 'to_token', 'buytoken', 'buy_token', 'tokentobuy', 'mintout', 'outmint', 'to'];
/** Parameter names that name a token without a direction (single-token buy tools). */
const TOKEN_KEYS = ['token', 'tokenaddress', 'token_address', 'mint', 'ca', 'contract', 'contractaddress', 'contract_address', 'address', 'asset'];
/** Parameter names whose address is a PERSON, never the token: skipped everywhere. */
const PARTY_KEYS = /recipient|receiver|wallet|owner|sender|spender|from_address|payer|beneficiary|account|user/i;

/** Majors and stablecoins: nothing to learn, and checking them would spend the free allowance. */
const SKIP = new Set(
  [
    '0x0000000000000000000000000000000000000000',
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // native-asset sentinel
    '0x4200000000000000000000000000000000000006', // WETH (Base)
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC (Base)
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH (Ethereum)
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC (Ethereum)
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT (Ethereum)
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI (Ethereum)
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC (BSC)
    '0x55d398326f99059ff775485246999027b3197955', // USDT (BSC)
    'so11111111111111111111111111111111111111112', // wrapped SOL
    'epjfwdd5aufqssqem2qn1xzybapc8g4wegggkzwytdt1v', // USDC (Solana)
    'es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb', // USDT (Solana)
  ],
);

const CHAIN_NAMES: Record<string, Chain> = {
  base: 'base', '8453': 'base', 'eip155:8453': 'base',
  ethereum: 'ethereum', eth: 'ethereum', mainnet: 'ethereum', '1': 'ethereum', 'eip155:1': 'ethereum',
  bsc: 'bsc', bnb: 'bsc', binance: 'bsc', '56': 'bsc', 'eip155:56': 'bsc',
  solana: 'solana', sol: 'solana',
};

/** A chain value we do NOT serve (arbitrum, polygon…) means "don't guess": no check rather than a wrong one. */
type ChainRead = Chain | 'unsupported' | undefined;

function readChain(v: unknown): ChainRead {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).toLowerCase().trim();
  return CHAIN_NAMES[s] ?? 'unsupported';
}

function norm(k: string): string {
  return k.toLowerCase().replace(/-/g, '_').replace(/^_+/, '');
}

function skip(token: string): boolean {
  return SKIP.has(token.toLowerCase());
}

function isEvm(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

/** Flags naming the token being SOLD or spent (see fromCommand for when that excuses a check). */
const IN_FLAGS = ['token-in', 'input-mint', 'from-token', 'sell-token', 'from', 'in'];
const OUT_FLAGS = ['token-out', 'output-mint', 'to-token', 'buy-token', 'mint', 'token', 'ca'];

function commandOf(params: Record<string, unknown>): string | undefined {
  for (const k of ['command', 'cmd', 'script', 'input']) if (typeof params[k] === 'string') return params[k] as string;
  return undefined;
}

/** Every value of the given flags in a segment (`--token-out 0x…`, `--mint=…`). */
function flags(seg: string, names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) for (const m of seg.matchAll(new RegExp(`--${n}(?:=|\\s+)['"]?([^\\s'"]+)`, 'gi'))) out.push(m[1]);
  return out;
}

/**
 * The tokens a tool call would buy, or `[]` when it is not a buy (or names no token we can check).
 * `defaultChain` is used for an EVM address when nothing in the call names a chain.
 */
export function detectTrade(toolName: string, params: Record<string, unknown>, defaultChain: Exclude<Chain, 'solana'> = 'base'): TradeTarget[] {
  const found: TradeTarget[] = [];
  const cmd = commandOf(params);
  // Any tool's command-like string is read: a false positive costs one check and never blocks alone.
  if (cmd !== undefined) found.push(...fromCommand(cmd, defaultChain));
  // A trade tool is read from its structured parameters too, so a string field that happens to be
  // called `input` can never hide them.
  if (TRADE_TOOL.test(toolName)) found.push(...fromParams(params, defaultChain));
  const seen = new Set<string>();
  return found.filter((t) => {
    const k = `${t.chain}:${t.token.toLowerCase()}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/**
 * Each shell segment (split at ; && || | newlines and command substitution) is read on its own, so
 * `--token-out <USDC>; buy <scam>` cannot hide the second buy behind the first, and a chain flag only
 * applies to the segment it is in. Known limit: a token passed through a shell variable is not seen.
 */
/**
 * Fail-closed by construction. Commit review found six ways in a row to make a hand-rolled shell
 * parser misread a command (quotes, comments, `$'…'`, operators inside quotes), so nothing here relies
 * on parsing shell correctly. A misreading can only ADD checks, never remove one:
 * - the command is a trade if ANY part of it uses a trade verb;
 * - the token is checked on the default chain AND every supported chain named anywhere (comments
 *   included); an unsupported chain named anywhere is also reported;
 * - the one exemption (the token being SOLD is not checked, so a rug's holder can still exit) applies
 *   only when the command is unambiguous: no `#`, no `$'…'`, balanced quotes, and every mention of the
 *   token on the sell side. Otherwise every address is checked.
 * Known limit: a token passed through a shell variable is not seen.
 */
function fromCommand(cmd: string, defaultChain: Exclude<Chain, 'solana'>): TradeTarget[] {
  if (!TRADE_VERB.test(cmd)) return [];

  const named = flags(cmd, ['chain', 'network']).map((v) => readChain(v));
  const supported = new Set(named.filter((c): c is Chain => c !== undefined && c !== 'unsupported'));
  const unsupportedNamed = named.includes('unsupported');
  // The default chain is ALWAYS checked: a chain flag (perhaps inside a comment) can add chains but
  // never remove the one the token most likely lives on. Named chains first.
  const evmChains = [...new Set([...[...supported].filter((c): c is Exclude<Chain, 'solana'> => c !== 'solana'), defaultChain])];

  const unambiguous = !/#|\$'/.test(cmd) && (cmd.match(/"/g) ?? []).length % 2 === 0 && (cmd.match(/'/g) ?? []).length % 2 === 0;
  const sold = new Map<string, number>();
  if (unambiguous) {
    const markSold = (v: string) => sold.set(v.toLowerCase(), (sold.get(v.toLowerCase()) ?? 0) + 1);
    for (const v of flags(cmd, IN_FLAGS)) markSold(v);
    // `awal trade <amount> <from> <to>`: <from> is what is being sold (awal's syntax only).
    for (const seg of cmd.split(/;|&&?|\|\|?|\n/)) {
      const positional = /\bawal\b/.test(seg) ? seg.match(/\btrade\s+(\S+)\s+(\S+)\s+(\S+)/) : null;
      if (positional) markSold(positional[2].replace(/['"]/g, ''));
    }
  }
  const mentions = (v: string) => cmd.toLowerCase().split(v.toLowerCase()).length - 1;
  const keep = (v: string) => !skip(v) && (sold.get(v.toLowerCase()) ?? 0) < mentions(v);

  const out: TradeTarget[] = [];
  const evm = [...new Set([...cmd.matchAll(EVM_ADDRESS)].map((m) => m[0]))].filter(keep);
  // Every EVM address that is not a major or the token being sold. A recipient wallet that slips in
  // comes back "not a token", which the guard lets through.
  for (const chain of evmChains) for (const a of evm) out.push({ chain, token: a });
  if (unsupportedNamed) for (const a of evm) out.push({ chain: 'unsupported', token: a });

  const words = [...new Set(cmd.split(/[\s;|&`()]+/).map((x) => x.replace(/^[^=]*=/, '').replace(/['"]/g, '')))];
  if (supported.has('solana')) {
    for (const w of words) if (SOLANA_MINT.test(w) && keep(w)) out.push({ chain: 'solana', token: w });
  } else if (!supported.size) {
    for (const v of flags(cmd, OUT_FLAGS)) if (SOLANA_MINT.test(v) && !isEvm(v) && keep(v)) out.push({ chain: 'solana', token: v });
  }
  return out;
}

function fromParams(params: Record<string, unknown>, defaultChain: Exclude<Chain, 'solana'>): TradeTarget[] {
  const flat = flatten(params);
  const chain = readChain(flat.get('chain') ?? flat.get('network') ?? flat.get('chainid') ?? flat.get('chain_id'));
  for (const keys of [OUT_KEYS, TOKEN_KEYS]) {
    for (const k of keys) {
      const v = flat.get(k);
      if (typeof v === 'string') {
        const t = target(v, chain, defaultChain, true);
        if (t.length) return t;
      }
    }
  }
  return [];
}

/** Top-level and one nested level of params, keys normalised; party-like keys dropped. */
function flatten(params: Record<string, unknown>): Map<string, unknown> {
  const m = new Map<string, unknown>();
  const add = (k: string, v: unknown) => {
    const n = norm(k);
    if (PARTY_KEYS.test(n)) return;
    if (!m.has(n)) m.set(n, v);
    const squashed = n.replace(/_/g, '');
    if (!m.has(squashed)) m.set(squashed, v);
  };
  for (const [k, v] of Object.entries(params)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) add(k2, v2);
    else add(k, v);
  }
  return m;
}

function target(raw: string, chain: ChainRead, defaultChain: Exclude<Chain, 'solana'>, named: boolean): TradeTarget[] {
  const v = raw.trim();
  if (skip(v)) return [];
  if (isEvm(v)) return [{ chain: chain === 'unsupported' ? 'unsupported' : chain && chain !== 'solana' ? chain : defaultChain, token: v }];
  // A Solana mint only where a key/flag names a token AND nothing says it is an EVM chain.
  if (named && SOLANA_MINT.test(v) && (chain === undefined || chain === 'solana')) return [{ chain: 'solana', token: v }];
  return [];
}
