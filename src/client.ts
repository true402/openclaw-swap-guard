// Who this client is, for the true402 update notice. Kept OUT of the shared payment code (x402.ts),
// which is byte-identical across packages; this is the one file that differs per package.
// `src/clients/registry.test.ts` in the true402 repo holds it equal to package.json.
export const CLIENT = { id: 'openclaw-guard', version: '1.0.3', package: '@true402.dev/openclaw-swap-guard', install: 'openclaw plugins install @true402.dev/openclaw-swap-guard' } as const;
