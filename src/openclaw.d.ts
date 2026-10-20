// The two OpenClaw SDK shapes this plugin uses, declared locally: the real SDK ships only inside the
// ~250 MB `openclaw` package, which the host provides at runtime (a peerDependency, never bundled).
// Field names follow docs/plugins/hooks/tool-policy.md and sdk-entrypoints (openclaw 2026.10.x).
declare module 'openclaw/plugin-sdk/plugin-entry' {
  export interface BeforeToolCallEvent {
    toolName: string;
    params: Record<string, unknown>;
  }
  export interface BeforeToolCallContext {
    abortSignal?: AbortSignal;
  }
  export interface OpenClawPluginApi {
    pluginConfig?: unknown;
    logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
    on(
      hook: 'before_tool_call',
      handler: (event: BeforeToolCallEvent, ctx: BeforeToolCallContext) => unknown,
      opts?: { priority?: number; matcher?: string[] },
    ): void;
  }
  export function definePluginEntry<T extends { id: string; name: string; description: string; register(api: OpenClawPluginApi): void }>(entry: T): T;
}
