import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChecker, evmVerdict, solanaVerdict, fileSpendStore, memorySpendStore } from './check';

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
    // Like the real fetch: hangs until its AbortSignal fires.
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))));
    await expect(createChecker({ timeoutMs: 20 })({ chain: 'base', token: ADDR })).rejects.toThrow();
  });
});

describe('createChecker: an overall spending limit (ClawHub scan, 2026-10-20)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('stops paying after maxPaidChecksPerDay, and starts again the next UTC day', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 402 })));
    let t = Date.parse('2026-10-20T10:00:00Z');
    // payStall is never reached with this key once the limit is hit; before that it fails on the stub's
    // empty 402 — either way the limit decides whether a payment is even attempted.
    const check = createChecker({ payerPrivateKey: '0x' + '11'.repeat(32), maxPaidChecksPerDay: 2, now: () => t, spendStore: memorySpendStore() });
    for (let i = 0; i < 2; i++) await expect(check({ chain: 'base', token: ADDR })).rejects.not.toThrow(/daily limit/);
    await expect(check({ chain: 'base', token: ADDR })).rejects.toThrow(/daily limit of 2 paid checks/);
    t = Date.parse('2026-10-21T00:00:01Z');
    await expect(check({ chain: 'base', token: ADDR })).rejects.not.toThrow(/daily limit/);
  });
});

describe('the daily limit survives a restart (ClawHub scan of 1.0.2)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('a new checker on the same file sees the count already spent today', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 402 })));
    const path = join(mkdtempSync(join(tmpdir(), 'guard-')), 'spend.json');
    const t = Date.parse('2026-10-20T10:00:00Z');
    const key = '0x' + '11'.repeat(32);
    const first = createChecker({ payerPrivateKey: key, maxPaidChecksPerDay: 1, now: () => t, spendStore: fileSpendStore(path) });
    await expect(first({ chain: 'base', token: ADDR })).rejects.not.toThrow(/daily limit/);
    const afterRestart = createChecker({ payerPrivateKey: key, maxPaidChecksPerDay: 1, now: () => t, spendStore: fileSpendStore(path) });
    await expect(afterRestart({ chain: 'base', token: ADDR })).rejects.toThrow(/daily limit of 1 paid checks/);
  });

  it('if the count cannot be saved, no payment is made', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 402 })));
    const broken = { read: () => ({ day: '', count: 0 }), write: () => { throw new Error('read-only disk'); }, locked: <T>(fn: () => T) => fn() };
    await expect(createChecker({ payerPrivateKey: '0x' + '11'.repeat(32), spendStore: broken })({ chain: 'base', token: ADDR })).rejects.toThrow(/no payment was made/);
  });
});

describe('the daily limit holds across PROCESSES (commit review of the Hermes port, 2026-10-20)', () => {
  it('two processes sharing one state directory never exceed the limit together', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-mp-'));
    const path = join(dir, 'spend.json');
    // Each child runs 20 locked increments against the same file, bounded at 25 in total.
    const child = `
      import { fileSpendStore } from ${JSON.stringify(join(__dirname, 'check.ts'))};
      const s = fileSpendStore(${JSON.stringify(path)});
      const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      // Start together, and hold each read-compare-write for 2 ms: without the lock, overlap is certain.
      while (Date.now() < Number(process.env.START_AT)) pause(1);
      let ok = 0;
      for (let i = 0; i < 20; i++) s.locked(() => { const v = s.read(); pause(2); if (v.count < 25) { s.write({ day: 'd', count: v.count + 1 }); ok++; } });
      console.log(ok);
    `;
    const startAt = String(Date.now() + 1500);
    const run = () => new Promise<number>((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], { cwd: join(__dirname, '..'), env: { ...process.env, START_AT: startAt } });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('close', () => resolve(Number(out.trim())));
      });
    });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a + b).toBe(25);
    expect(JSON.parse(readFileSync(path, 'utf8')).count).toBe(25);
  }, 30_000);
});
