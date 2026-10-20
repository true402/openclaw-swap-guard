// x402.ts — pay any true402 stall and return its JSON. The whole protocol: 402 → sign EIP-3009 → 200.
// No accounts, no API keys; the wallet is the identity. USDC on Base, gas sponsored by the facilitator.
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { CLIENT } from './client.js';

const USDC_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface PayOpts {
  /** A Base wallet private key holding a little USDC (the payer). */
  payerPrivateKey: string;
  /** true402 API base. Default https://true402.dev/api */
  baseUrl?: string;
  /** Base RPC. Default https://mainnet.base.org */
  rpcUrl?: string;
  /**
   * Hard ceiling, in USDC, on a single signed payment (default 0.25). The client REFUSES to sign a 402
   * that demands more — so a rogue/compromised endpoint (or a MITM past TLS) can't drain the payer.
   *
   * 0.25 matches every sibling client package. This one was left on 0.10 when the others were raised
   * (2026-08-23) and was the only published client that could not have bought the catalog's top price
   * — the site says "every client refuses above $0.25", so this is what makes that sentence true.
   * Set above the server's own per-request ceiling (MAX_REQUEST_PRICE_USD) so a legitimately-priced
   * stall is never blocked by the default, while an out-of-catalog demand still is.
   * Note: the per-page SEO audit can exceed $0.25 for many pages — raise this to audit large batches.
   */
  maxAmountUsd?: number;
}

const BASE_USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
const BASE_NETWORK = 'eip155:8453';

// Request deadlines. Without one a stalled endpoint parks the CLI on undici's ~5-minute default.
// The PAID leg is far more generous than the probe: the server settles on 2xx, so abandoning a
// merely SLOW paid response would mean the buyer paid and got nothing.
// How long the signed USDC authorization stays broadcastable.
//
// `maxTimeoutSeconds` comes from the server being paid and arrives as JSON, so the `number` type is
// a promise nothing keeps: a string made `now + "300"` CONCATENATE, turning a 300-second quote into
// a 56,670-year one, and a plain large number was never bounded at all. Amount, asset, network,
// recipient and nonce are already pinned — the window is the only thing left to get wrong.
const MIN_AUTH_WINDOW_S = 30;
const MAX_AUTH_WINDOW_S = 600;
const DEFAULT_AUTH_WINDOW_S = 120;

/** Exported for `src/published-clients.test.ts`, the only test covering these packages. */
export function authWindowSeconds(raw: unknown): number {
  const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_AUTH_WINDOW_S;
  return Math.min(MAX_AUTH_WINDOW_S, Math.max(MIN_AUTH_WINDOW_S, n));
}

// Update notice. Every request says which client it is (`true402-<id>/<version>`); when a newer
// release exists, true402 answers with `X-True402-Client-Latest` and `X-True402-Client-Update`
// (`recommended` | `required`), and we print ONE line, once per process, on stderr.
//
// The message is built HERE, from this package's own name and install command. Only a strictly
// validated version number is taken from the response — `baseUrl` can point at any seller, and
// printing a server's free text would let a hostile one tell the user to install something else.
const USER_AGENT = `true402-${CLIENT.id}/${CLIENT.version} (+https://true402.dev/integrations)`;
let updateNoticeShown = false;

const DEFAULT_ORIGIN = 'https://true402.dev/api';
const isTrue402 = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === 'true402.dev' || host.endsWith('.true402.dev');
  } catch {
    return false;
  }
};

const isNewer = (a: string, b: string): boolean => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** The line to print for this response, or null. Exported for `src/published-clients.test.ts`. */
export function updateNotice(res: Response, fromUrl: string = DEFAULT_ORIGIN): string | null {
  // Only true402 itself may say we are out of date. Any other seller could otherwise make this
  // client print a fake "security fix pending" — it could not change what gets installed (that
  // command is ours), but it could alarm the user.
  if (!isTrue402(fromUrl)) return null;
  // Never throws: a notice must not be able to break a paid call (or a stub without headers).
  let latest = '';
  let required = false;
  try {
    latest = res.headers.get('x-true402-client-latest')?.trim() ?? '';
    required = res.headers.get('x-true402-client-update') === 'required';
  } catch {
    return null;
  }
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(latest) || !isNewer(latest, CLIENT.version)) return null;
  return required
    ? `[true402] ${CLIENT.package} ${CLIENT.version} has a security fix pending — update to ${latest}: ${CLIENT.install}`
    : `[true402] ${CLIENT.package} ${latest} is available (you have ${CLIENT.version}): ${CLIENT.install}`;
}

function noteUpdate(res: Response, fromUrl: string): void {
  if (updateNoticeShown) return;
  const line = updateNotice(res, fromUrl);
  if (!line) return;
  updateNoticeShown = true;
  console.warn(line);
}

const PROBE_TIMEOUT_MS = 30_000;
const PAID_TIMEOUT_MS = 120_000;

/**
 * The server's own words, appended to a client error. Without it a caller sees only "got 400" and
 * cannot tell a fixable problem (raise the cap, fix the input) from an outage. Best-effort and
 * capped: a body that will not read must never mask the failure being reported.
 */
async function serverReason(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    return text ? ` — ${text.slice(0, 300)}` : '';
  } catch {
    return '';
  }
}

/**
 * May a signed payment be sent to this URL? https, or plain http to THIS machine for development.
 *
 * Decided on the PARSED hostname: the prefix regex this replaced also accepted
 * `http://localhost:x@evil.example/` — userinfo first, then the real host — and sent the payment there
 * in cleartext.
 */
function isSecureUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/**
 * Redirects are never followed. fetch re-sends a 307/308 with the same method, body AND headers —
 * PAYMENT-SIGNATURE included — to wherever `Location` points, https to http included, so following
 * one would hand a signed, claimable authorization to a host this client never vetted. Both requests
 * use `redirect: 'manual'` and any 3xx is an error.
 */
function refuseRedirect(res: Response, url: string): void {
  if (String(res.type) === 'opaqueredirect' || (res.status >= 300 && res.status < 400))
    throw new Error(`${url} answered HTTP ${res.status}: server redirected; refusing to send a payment elsewhere`);
}

interface Accept {
  scheme: string; network: string; asset: string; payTo: string;
  amount?: string; maxAmountRequired?: string; maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

/** POST a payload to a true402 stall path (e.g. '/v1/base/token-report'), paying over x402. */
export async function payStall<T = unknown>(path: string, payload: Record<string, unknown>, opts: PayOpts): Promise<T> {
  const baseUrl = opts.baseUrl ?? 'https://true402.dev/api';
  const rpcUrl = opts.rpcUrl ?? 'https://mainnet.base.org';
  const key = (opts.payerPrivateKey.startsWith('0x') ? opts.payerPrivateKey : `0x${opts.payerPrivateKey}`) as Hex;
  const account = privateKeyToAccount(key);
  const url = `${baseUrl}${path}`;
  const body = JSON.stringify(payload);

  const first = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  noteUpdate(first, url);
  refuseRedirect(first, url);
  // Any 2xx is a served response (the free trial answers 200 without payment); the gate settles on
  // 2xx too, so these two checks must agree on what "served" means.
  if (first.ok) return (await first.json()) as T;
  if (first.status !== 402)
    throw new Error(`expected HTTP 402 from ${path}, got ${first.status}${await serverReason(first)}`);

  const challenge = (await first.json()) as { accepts?: Accept[] };
  // true402 quotes MORE THAN ONE rail and both carry `scheme: "exact"` — EVM and Solana. Matching on
  // scheme alone returns whatever the server listed FIRST, which works only because the server keeps
  // EVM at accepts[0]; that invariant lives in another codebase and a published CLI already installed
  // cannot be hot-fixed if it moves. The network is REQUIRED: an unnamed chain is not one we can pay.
  const req = (challenge.accepts ?? []).find((a) => a.scheme === 'exact' && a.network === BASE_NETWORK);
  if (!req)
    throw new Error(
      `no payable x402 requirement in the 402 — this client settles USDC on ${BASE_NETWORK} only`,
    );

  // Only sign a USDC-on-Base charge within the caller's cap — a rogue/compromised endpoint (or MITM
  // past TLS) can't make the agent authorize an unexpected asset/network or an excessive amount.
  if (req.network !== BASE_NETWORK) throw new Error(`unexpected payment network "${req.network}" (expected ${BASE_NETWORK}) — refusing to sign`);
  const usdc = getAddress(req.asset);
  if (usdc !== BASE_USDC) throw new Error(`unexpected payment asset ${usdc} (expected Base USDC) — refusing to sign`);
  // Digits only, and positive: `BigInt` would also take '0x10', ' 12 ' or '' (= 0n).
  const rawAmount = req.amount ?? req.maxAmountRequired;
  if (rawAmount === undefined || !/^\d+$/.test(String(rawAmount)) || BigInt(rawAmount) <= 0n)
    throw new Error('402 carries no positive payment amount — refusing to sign');
  const value = BigInt(rawAmount);
  const capAtomic = BigInt(Math.round((opts.maxAmountUsd ?? 0.25) * 1e6));
  if (value > capAtomic) throw new Error(`402 demands ${value} USDC base units, over the $${opts.maxAmountUsd ?? 0.25} cap (maxAmountUsd) — refusing to sign`);
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl) });
  // The balance pre-check is ADVISORY: it only turns "you will be refused" into a clear local
  // message. The server verifies the balance itself and charges nothing when it is short, so an RPC
  // that cannot answer (the free public endpoint rate-limits) must not abort a payable call —
  // measured 2026-10-02: a paid call died on a 429 from mainnet.base.org with a raw viem error.
  const held = (await pub
    .readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] })
    .catch(() => null)) as bigint | null;
  if (held !== null && held < value) throw new Error(`payer ${account.address} holds ${held} < ${value} USDC base units — fund it`);

  // Never send a signed payment over cleartext: an on-path observer could lift the authorization
  // and race it to settlement. Localhost is allowed for development.
  if (!isSecureUrl(url)) {
    throw new Error(`refusing to send a signed payment over cleartext (${url}) — use https`);
  }
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address, to: getAddress(req.payTo), value,
    validAfter: BigInt(now - 60), validBefore: BigInt(now + authWindowSeconds(req.maxTimeoutSeconds)),
    nonce: `0x${randomBytes(32).toString('hex')}` as Hex,
  };
  const signature = await account.signTypedData({
    domain: { name: req.extra?.name ?? 'USD Coin', version: req.extra?.version ?? '2', chainId: base.id, verifyingContract: usdc },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });
  const xPayment = Buffer.from(JSON.stringify({
    x402Version: 2, accepted: req,
    payload: {
      signature,
      authorization: {
        from: authorization.from, to: authorization.to, value: value.toString(),
        validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString(), nonce: authorization.nonce,
      },
    },
  })).toString('base64');
  const paid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, 'PAYMENT-SIGNATURE': xPayment },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(PAID_TIMEOUT_MS),
  });
  noteUpdate(paid, url);
  refuseRedirect(paid, url);
  if (!paid.ok)
    throw new Error(
      `paid request to ${path} failed (HTTP ${paid.status}): the server reported failure — a seller ` +
        `following x402 settles only on a 2xx${await serverReason(paid)}`,
    );
  return (await paid.json()) as T;
}
