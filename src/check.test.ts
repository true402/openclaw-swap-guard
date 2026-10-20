import { describe, it, expect, vi, afterEach } from 'vitest';
import { createChecker, evmVerdict, solanaVerdict } from './check';

const ADDR = '0x1111111111111111111111111111111111111111';

describe('evmVerdict', () => {
  it('maps avoid / caution / ok', () => {
    expect(evmVerdict({ verdict: { rating: 'avoid', reasons: ['honeypot: the sell side is blocked'] } }, 'base')).toEqual({ level: 'danger', reasons: ['honeypot: the sell side is blocked'] });
    expect(evmVerdict({ verdict: { rating: 'caution', reasons: [] } }, 'base').level).toBe('caution');
    expect(evmVerdict({ verdict: { rating: 'ok' } }, 'base').level).toBe('ok');
  });

  it('a non-contract is "unchecked", not danger: a wallet in the command, or a token on another chain', () => {
    const r = { verdict: { rating: 'avoid', reasons: ['address is not a contract'] }, safety: { flags: ['not_a_contract'] } };
    expect(evmVerdict(r, 'base')).toEqual({ level: 'unchecked', notToken: true, reasons: ['no token contract at this address on base'] });
  });

  it('an answer without a verdict is unchecked; reason text is cleaned', () => {
    expect(evmVerdict({}, 'base').level).toBe('unchecked');
    expect(evmVerdict({ verdict: { rating: 'avoid', reasons: ['a\u001b[2Jb', 7] } }, 'base').reasons).toEqual(['a [2Jb']);
  });
});

describe('solanaVerdict', () => {
  it('critical is danger; an unsellable or seizable token is danger at any score', () => {
    expect(solanaVerdict({ risk: 'critical', flags: [] }).level).toBe('danger');
    expect(solanaVerdict({ risk: 'medium', flags: ['non_transferable'] }).level).toBe('danger');
    expect(solanaVerdict({ risk: 'low', flags: ['permanent_delegate'] }).level).toBe('danger');
  });

  it('a freeze authority blocks only when the risk is already high; otherwise caution', () => {
    expect(solanaVerdict({ risk: 'high', flags: ['freeze_authority_active'] }).level).toBe('danger');
    expect(solanaVerdict({ risk: 'medium', flags: ['freeze_authority_active'] }).level).toBe('caution');
    expect(solanaVerdict({ risk: 'high', flags: ['low_liquidity'] }).level).toBe('caution');
    expect(solanaVerdict({ risk: 'low', flags: ['established_liquidity'] }).level).toBe('ok');
  });

  it('not a mint is unchecked', () => {
    expect(solanaVerdict({ risk: 'critical', flags: ['mint_unreadable'] }).level).toBe('unchecked');
  });
});

describe('createChecker without a payer key (free checks)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (status: number, body: unknown) => {
    const f = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('asks token-report on the token\'s chain, with our client User-Agent', async () => {
    const f = stub(200, { verdict: { rating: 'avoid', reasons: ['rug'] } });
    expect((await createChecker()({ chain: 'ethereum', token: ADDR })).level).toBe('danger');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://true402.dev/api/v1/ethereum/token-report');
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/^true402-openclaw-guard\/\d+\.\d+\.\d+/);
    expect(JSON.parse(init.body as string)).toEqual({ token: ADDR });
  });

  it('Solana mints go to solana/token-safety', async () => {
    const f = stub(200, { risk: 'low', flags: [] });
    await createChecker()({ chain: 'solana', token: 'So1anaMint111111111111111111111111111111111' });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://true402.dev/api/v1/solana/token-safety');
  });

  it('a 402 (free checks used up) or a server error throws, which the guard treats as unchecked', async () => {
    stub(402, {});
    await expect(createChecker()({ chain: 'base', token: ADDR })).rejects.toThrow(/PAYER_PRIVATE_KEY/);
    stub(503, {});
    await expect(createChecker()({ chain: 'base', token: ADDR })).rejects.toThrow(/503/);
  });

  it('gives up at the deadline', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    await expect(createChecker({ timeoutMs: 20 })({ chain: 'base', token: ADDR })).rejects.toThrow(/20 ms/);
  });
});
