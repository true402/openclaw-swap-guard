import { describe, it, expect } from 'vitest';
import { detectTrade } from './detect';

const ADDR = '0x1111111111111111111111111111111111111111';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

describe('exec commands (the shapes real ClawHub trading skills run)', () => {
  it('awal trade <amount> <from> <to>: the token being bought, majors skipped', () => {
    expect(detectTrade('exec', { command: `npx awal@latest trade 0.50 usdc ${ADDR}` })).toEqual([{ chain: 'base', token: ADDR }]);
  });

  it('uniswap-v4 --token-out with --chain', () => {
    const command = `npx tsx src/swap.ts --token-in ETH --token-out ${ADDR} --amount 0.1 --chain ethereum`;
    expect(detectTrade('exec', { command })).toEqual([{ chain: 'ethereum', token: ADDR }, { chain: 'base', token: ADDR }]);
  });

  it('buying a major is not checked (USDC as --token-out)', () => {
    expect(detectTrade('exec', { command: `npx tsx src/swap.ts --token-in ETH --token-out ${USDC_BASE} --chain base` })).toEqual([]);
  });

  it('tradr-enter <CA> --chain base, and a bare Solana mint with --chain solana', () => {
    expect(detectTrade('exec', { command: `python3 scripts/tradr-enter.py ${ADDR} --score 5 --chain base` })).toEqual([{ chain: 'base', token: ADDR }]);
    expect(detectTrade('exec', { command: `python3 scripts/tradr-enter.py ${MINT} --score 5 --chain solana` })).toEqual([{ chain: 'solana', token: MINT }]);
  });

  it('a chain we do not serve is reported as unsupported, never guessed', () => {
    expect(detectTrade('exec', { command: `npx tsx src/swap.ts --token-out ${ADDR} --chain arbitrum` })).toEqual([{ chain: 'base', token: ADDR }, { chain: 'unsupported', token: ADDR }]);
    expect(detectTrade('swap', { tokenOut: ADDR, chain: 'polygon' })).toEqual([{ chain: 'unsupported', token: ADDR }]);
  });

  it('commands that do not acquire a token are ignored', () => {
    expect(detectTrade('exec', { command: `npx tsx src/pool-info.ts --token0 ETH --token1 ${ADDR} --chain base` })).toEqual([]);
    expect(detectTrade('exec', { command: `cast balance ${ADDR}` })).toEqual([]);
    expect(detectTrade('exec', { command: 'ls -la' })).toEqual([]);
  });

  it('an unusable flag value falls back to the addresses on the line', () => {
    expect(detectTrade('exec', { command: `bot buy --token PEPE ${ADDR}` })).toEqual([{ chain: 'base', token: ADDR }]);
  });

  it('a natural-language order with no address cannot be checked (bankr prompt)', () => {
    expect(detectTrade('exec', { command: 'bankr prompt "Buy $20 of PEPE on Base"' })).toEqual([]);
  });

  it('defaultChain applies when nothing names a chain', () => {
    expect(detectTrade('exec', { command: `npx awal@latest trade 1 usdc ${ADDR}` }, 'bsc')).toEqual([{ chain: 'bsc', token: ADDR }]);
  });
});

describe('structured tools (MCP / plugin tools)', () => {
  it('output-token parameters win over input-token ones', () => {
    expect(detectTrade('uniswap__swap', { tokenIn: '0x2222222222222222222222222222222222222222', tokenOut: ADDR, chainId: 8453 })).toEqual([{ chain: 'base', token: ADDR }]);
  });

  it('a Jupiter-style outputMint is a Solana token', () => {
    expect(detectTrade('jupiter_swap', { inputMint: 'So11111111111111111111111111111111111111112', outputMint: MINT, amount: 1 })).toEqual([{ chain: 'solana', token: MINT }]);
  });

  it('nested params are read one level deep', () => {
    expect(detectTrade('buy_token', { order: { token: ADDR, chain: 'bsc' } })).toEqual([{ chain: 'bsc', token: ADDR }]);
  });

  it('a recipient or wallet address is never treated as the token', () => {
    expect(detectTrade('buy_token', { recipient: ADDR })).toEqual([]);
    expect(detectTrade('swap', { walletAddress: ADDR, tokenOut: USDC_BASE })).toEqual([]);
  });

  it('non-trading tools are ignored even with a token in their params', () => {
    expect(detectTrade('get_price', { token: ADDR })).toEqual([]);
    expect(detectTrade('read', { path: '/tmp/x' })).toEqual([]);
  });

  it('a base58 string under an EVM chain is not taken for a Solana mint', () => {
    expect(detectTrade('swap', { tokenOut: MINT, chain: 'base' })).toEqual([]);
  });
});

describe('evasion attempts (commit security review, 2026-10-19)', () => {
  const SCAM = '0x5555555555555555555555555555555555555555';

  it('a major named first cannot hide a second buy in another shell segment', () => {
    for (const sep of ['; ', ' && ', ' || ', ' | ', '\n', ' $(', ' `']) {
      const command = `npx tsx src/swap.ts --token-out ${USDC_BASE}${sep}bot buy ${SCAM}`;
      expect(detectTrade('exec', { command }), JSON.stringify(sep)).toEqual([{ chain: 'base', token: SCAM }]);
    }
  });

  it('a chain flag anywhere can only add checks: the default chain is still checked', () => {
    const command = `bridge --chain arbitrum ok; npx awal@latest trade 1 usdc ${SCAM}`;
    expect(detectTrade('exec', { command })).toContainEqual({ chain: 'base', token: SCAM });
  });

  it('the token being SOLD is not checked — blocking an exit would trap the user in a rug', () => {
    expect(detectTrade('exec', { command: `npx tsx src/swap.ts --token-in ${SCAM} --token-out ${USDC_BASE} --chain base` })).toEqual([]);
    expect(detectTrade('exec', { command: `npx awal@latest trade 100 ${SCAM} usdc` })).toEqual([]);
  });

  it('any tool\'s command string is read, and a trade tool\'s structured params are always read', () => {
    expect(detectTrade('notes_write', { command: `buy ${SCAM}` })).toEqual([{ chain: 'base', token: SCAM }]);
    expect(detectTrade('swap', { input: 'swap tokens please', tokenOut: SCAM })).toEqual([{ chain: 'base', token: SCAM }]);
  });

  it('a shell comment cannot mark the bought token as sold', () => {
    expect(detectTrade('exec', { command: `bot buy ${SCAM} # --token-in ${SCAM}` })).toEqual([{ chain: 'base', token: SCAM }]);
  });

  it('a token named on both sides is still checked; the positional rule is awal-only', () => {
    expect(detectTrade('exec', { command: `bot swap --token-in ${SCAM} --token-out ${SCAM}` })).toEqual([{ chain: 'base', token: SCAM }]);
    expect(detectTrade('exec', { command: `othertool trade 1 ${SCAM} usdc` })).toEqual([{ chain: 'base', token: SCAM }]);
  });

  it('a single & splits segments too', () => {
    expect(detectTrade('exec', { command: `npx tsx src/swap.ts --token-out ${USDC_BASE} & bot buy ${SCAM}` })).toEqual([{ chain: 'base', token: SCAM }]);
  });

  it('conflicting chain flags check every chain named; an EVM address under --chain solana is unsupported', () => {
    expect(detectTrade('exec', { command: `bot buy ${SCAM} --chain base --chain arbitrum` })).toEqual([{ chain: 'base', token: SCAM }, { chain: 'unsupported', token: SCAM }]);
    expect(detectTrade('exec', { command: `bot buy ${SCAM} --chain base --chain bsc` })).toEqual([{ chain: 'base', token: SCAM }, { chain: 'bsc', token: SCAM }]);
    // A named solana never stops an EVM address being checked on the default chain.
    expect(detectTrade('exec', { command: `bot buy ${SCAM} --chain solana` })).toEqual([{ chain: 'base', token: SCAM }]);
  });

  it('a # inside quotes cannot hide the address after it', () => {
    expect(detectTrade('exec', { command: `bot buy --memo " #tag" ${SCAM}` })).toEqual([{ chain: 'base', token: SCAM }]);
  });

  it('a chain flag inside a comment cannot move the check off the default chain', () => {
    expect(detectTrade('exec', { command: `bot buy ${SCAM} # --chain arbitrum` })).toContainEqual({ chain: 'base', token: SCAM });
  });

  it('a # inside quotes is not a comment, so a real chain flag after it still counts', () => {
    expect(detectTrade('exec', { command: `bot buy --memo " #x" --chain bsc ${SCAM}` })).toEqual([{ chain: 'bsc', token: SCAM }, { chain: 'base', token: SCAM }]);
  });

  it('ambiguous shell ($\'…\', #, unbalanced quotes) removes the sold-token exemption, never adds a skip', () => {
    expect(detectTrade('exec', { command: `bot buy ${SCAM} $'\\'' # --chain arbitrum --token-in ${SCAM}` })).toContainEqual({ chain: 'base', token: SCAM });
    expect(detectTrade('exec', { command: `bot swap --token-in ${SCAM} --token-out ${USDC_BASE} "` })).toEqual([{ chain: 'base', token: SCAM }]);
  });

  it('an operator inside quotes cannot split a buy away from its trade verb', () => {
    expect(detectTrade('exec', { command: `bot buy "a;" ${SCAM}` })).toEqual([{ chain: 'base', token: SCAM }]);
  });

  it('a supported chain named in a comment or another segment adds a chain, never removes the default', () => {
    for (const command of [`bot buy ${SCAM} # --chain bsc`, `bot buy ${SCAM} # --chain solana`, `echo --network eth; bot buy ${SCAM}`]) {
      expect(detectTrade('exec', { command }), command).toContainEqual({ chain: 'base', token: SCAM });
    }
  });
});
