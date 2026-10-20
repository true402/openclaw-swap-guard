# @true402.dev/openclaw-swap-guard

**An OpenClaw plugin that checks every token your agent is about to buy, and blocks the trade when the token is a honeypot or a rug in progress.**

It hooks OpenClaw's `before_tool_call`, so it sits in front of *every* trading skill and MCP tool you have installed — Base trade skills, Uniswap, Jupiter, sniper bots, your own scripts. A skill the agent forgets to follow cannot skip it.

```bash
openclaw plugins install @true402.dev/openclaw-swap-guard
```

## What it does

Before a tool call that buys a token, the guard asks [true402](https://true402.dev):

| Chain | Check | Price after the free daily checks |
|---|---|---|
| Base, Ethereum, BSC | `/v1/{chain}/token-report`: an executed buy **and sell** simulation, deployer history, recent liquidity pulls | $0.008 |
| Solana | `/v1/solana/token-safety`: freeze / mint authority, Token-2022 extensions, liquidity | $0.005 |

- **Blocks** only on a definite danger verdict: an EVM token rated *avoid* (cannot be sold, extreme sell tax, liquidity just pulled…), or a Solana mint that can never be sold, can be seized, or is critical risk. The agent sees the reasons and is told not to retry with another tool.
- **Lets the trade through** when the token checks out — and, by default, when it could not be checked at all (true402 unreachable, free checks used up, the address is a wallet rather than a token). A guard that breaks your trading whenever a third party hiccups is a guard you uninstall. Change that with `onUnchecked`.
- Never blocks a **sale**. The token you are selling is not checked, and when a command is ambiguous enough that a dangerous token *might* be the one being sold, the guard asks you instead of blocking — trapping you in a token whose liquidity is being pulled would be worse than the trade.
- Skips majors and stablecoins (WETH, USDC, USDT, DAI, WBNB, SOL…), reuses a verdict for 10 minutes, and checks up to 5 distinct tokens per call — a call naming more is held for your approval (or blocked with `onUnchecked: block`). A token on a chain true402 does not serve counts as "could not be checked".

It recognises buys in shell commands the way trading skills run them (`--token-out 0x…`, `trade <amount> <from> <to>`, `<script> <CA> --chain base`, `--chain solana <mint>`) and in structured tool parameters (`tokenOut`, `outputMint`, `token`, …). Command parsing fails closed: a token is checked on the default chain and on every chain the command names, and anything ambiguous — a `#`, `$'…'`, unbalanced quotes — means every address is checked, including the one being sold. A plain-English order that names no address (`"buy $20 of PEPE"`), or a token passed through a shell variable, cannot be checked.

## Paying for checks

No setup is needed for a few checks a day: the guard uses true402's free daily allowance.

For more, give it a **dedicated, low-balance** Base wallet holding a little USDC (gas is sponsored):

```bash
export TRUE402_PAYER_PRIVATE_KEY=0x…
```

Only this dedicated variable is read — never a generic `PAYER_PRIVATE_KEY` another tool may have set. Each check then pays the exact quoted price over [x402](https://x402.org), no account and no API key. The key stays on your machine (it authorizes each USDC payment locally) and is never written to OpenClaw's config.

Spending is bounded twice: **at most $0.02 per check** (`maxAmountUsd`) and **at most 50 paid checks per UTC day** (`maxPaidChecksPerDay`) — at most $1.00 a day by default. The day's count is kept in `$OPENCLAW_STATE_DIR/true402-swap-guard/spend.json` (default `~/.openclaw/…`), so restarting OpenClaw does not reset it; if that file cannot be written, no payment is made. Past the limit only free checks run, and the guard logs a warning. The limit is per machine: several OpenClaw installs with their own state directories each have their own.

## Settings

All optional, under the plugin's config (`true402-swap-guard`):

| Setting | Default | Meaning |
|---|---|---|
| `defaultChain` | `base` | Chain assumed for a `0x` address when the trade names none (`base`, `ethereum`, `bsc`) |
| `onCaution` | `allow` | `ask` = request your approval on a *caution* verdict |
| `onUnchecked` | `allow` | `ask` or `block` when a token could not be checked |
| `allowTokens` | `[]` | Token addresses never checked |
| `timeoutMs` | `15000` | Give up on a free check after this long (then it is "unchecked"). A paid check is never abandoned once paid — you get the answer you paid for |
| `maxAmountUsd` | `0.02` | Never pay more than this for one check |
| `maxPaidChecksPerDay` | `50` | Paid checks per UTC day; after that only free checks run |

## What is sent

A **free check** sends only the token address and its chain to `true402.dev` — nothing about your wallet, your prompts or the trade.

A **paid check** also sends a signed USDC payment authorization. That necessarily reveals the paying wallet's **address** to true402, and the payment is settled on Base, where it is public. That is why the wallet should be a dedicated, low-balance one. The private key itself never leaves your machine.

## License

MIT
