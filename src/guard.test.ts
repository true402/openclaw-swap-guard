import { describe, it, expect, vi } from 'vitest';
import { createGuard, clean, type Verdict } from './guard';

const ADDR = '0x1111111111111111111111111111111111111111';
const buy = { command: `npx awal@latest trade 1 usdc ${ADDR}` };
const v = (level: Verdict['level'], reasons: string[] = []): Verdict => ({ level, reasons });

describe('createGuard', () => {
  it('blocks a trade rated dangerous, with the reasons', async () => {
    const guard = createGuard(async () => v('danger', ['cannot be sold (honeypot)']));
    const r = await guard('exec', buy);
    expect(r?.block).toBe(true);
    expect(r?.blockReason).toContain('cannot be sold (honeypot)');
    expect(r?.blockReason).toContain(ADDR);
  });

  it('lets ok and caution through by default', async () => {
    expect(await createGuard(async () => v('ok'))('exec', buy)).toBeUndefined();
    expect(await createGuard(async () => v('caution', ['young token']))('exec', buy)).toBeUndefined();
  });

  it('asks on caution when configured', async () => {
    const r = await createGuard(async () => v('caution', ['young token']), { onCaution: 'ask' })('exec', buy);
    expect(r?.requireApproval?.severity).toBe('warning');
    expect(r?.requireApproval?.description).toContain('young token');
  });

  it('never blocks on a failed check unless told to', async () => {
    const down = async (): Promise<Verdict> => { throw new Error('fetch failed'); };
    expect(await createGuard(down)('exec', buy)).toBeUndefined();
    expect((await createGuard(down, { onUnchecked: 'ask' })('exec', buy))?.requireApproval).toBeDefined();
    expect((await createGuard(down, { onUnchecked: 'block' })('exec', buy))?.block).toBe(true);
  });

  it('does not check non-trades, majors or allow-listed tokens', async () => {
    const check = vi.fn(async () => v('danger'));
    const guard = createGuard(check, { allowTokens: [ADDR.toUpperCase().replace('0X', '0x')] });
    expect(await guard('exec', { command: 'ls' })).toBeUndefined();
    expect(await guard('exec', buy)).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('reuses a verdict within the cache window, but never caches "unchecked"', async () => {
    let t = 0;
    const ok = vi.fn(async () => v('ok'));
    const guard = createGuard(ok, {}, () => t);
    await guard('exec', buy);
    await guard('exec', buy);
    expect(ok).toHaveBeenCalledTimes(1);
    t = 11 * 60_000;
    await guard('exec', buy);
    expect(ok).toHaveBeenCalledTimes(2);

    const flaky = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(v('danger'));
    const g2 = createGuard(flaky);
    expect(await g2('exec', buy)).toBeUndefined();
    expect((await g2('exec', buy))?.block).toBe(true);
  });

  it('blocks when any one of several tokens is dangerous', async () => {
    const other = '0x3333333333333333333333333333333333333333';
    const guard = createGuard(async (t) => (t.token === other ? v('danger', ['rug']) : v('ok')));
    const r = await guard('exec', { command: `bot buy ${ADDR} ${other}` });
    expect(r?.blockReason).toContain(other);
  });
});

describe('createGuard: nothing is dropped silently', () => {
  it('an unsupported chain and tokens past the limit are "unchecked", so onUnchecked applies', async () => {
    const check = vi.fn(async () => v('ok'));
    const unsupported = { command: `npx tsx src/swap.ts --token-out ${ADDR} --chain arbitrum` };
    expect(await createGuard(check)('exec', unsupported)).toBeUndefined();
    expect((await createGuard(check, { onUnchecked: 'block' })('exec', unsupported))?.block).toBe(true);
    // The default chain is still checked (a chain flag can only add checks); arbitrum is reported.
    expect(check).toHaveBeenCalledWith({ chain: 'base', token: ADDR }, undefined);
    check.mockClear();

    const many = Array.from({ length: 7 }, (_, i) => `0x${String(i + 1).repeat(40).slice(0, 40)}`);
    const cmd = { command: `bot buy ${many.join(' ')}` };
    const r = await createGuard(check, { onUnchecked: 'block' })('exec', cmd);
    expect(r?.block).toBe(true);
    expect(r?.blockReason).toContain('at most 5 per call');
    // Even under the default 'allow', too many tokens are never waved through: the user is asked.
    expect((await createGuard(check)('exec', cmd))?.requireApproval).toBeDefined();
    expect(check).not.toHaveBeenCalled();

    // Several chains for ONE token count once against the cap, and "not a token here" on the other
    // chain does not hide a real verdict.
    const perChain = vi.fn(async (t: { chain: string }) => (t.chain === 'bsc' ? v('ok') : { level: 'unchecked' as const, notToken: true, reasons: ['no token contract at this address on base'] }));
    expect(await createGuard(perChain, { onUnchecked: 'block' })('exec', { command: `bot buy ${ADDR} --chain bsc` })).toBeUndefined();

    // But a FAILED check on the named chain is never replaced by a clean result elsewhere.
    const bscDown = vi.fn(async (t: { chain: string }) => { if (t.chain === 'bsc') throw new Error('fetch failed'); return v('ok'); });
    expect((await createGuard(bscDown, { onUnchecked: 'block' })('exec', { command: `bot buy ${ADDR} --chain bsc` }))?.block).toBe(true);
  });
});

describe('createGuard: unchecked trades are not silent', () => {
  it('warns once per reason per 10 minutes', async () => {
    let t = 0;
    const warn = vi.fn();
    const guard = createGuard(async () => { throw new Error('the free daily checks are used up'); }, { warn }, () => t);
    await guard('exec', buy);
    await guard('exec', buy);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('free daily checks are used up');
    expect(warn.mock.calls[0][0]).toContain('allowed unchecked');
    t = 11 * 60_000;
    await guard('exec', buy);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('clean', () => {
  it('strips control and bidi characters and bounds the length', () => {
    expect(clean('a\u001b[31mb‮c\n d')).toBe('a [31mb c d');
    expect(clean('x'.repeat(500)).length).toBe(160);
  });
});
