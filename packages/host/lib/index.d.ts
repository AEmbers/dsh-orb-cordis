import "@dsh-orb/native-selection";
//#region src/orb.d.ts
/** Host services the plugin injects. Shapes match the official 0.1.7-rc.2 controllers. */
interface OrbContext {
  readonly webServer: {
    readonly port: number;
    register(route: {
      kind: 'prefix';
      path: string;
      handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
    }): () => void;
  };
  readonly connection: {
    authenticatedUrl(baseUrl: string): string;
    admit?(request: import('node:http').IncomingMessage): {
      rejection?: number;
    } | {
      peer?: unknown;
    };
    isAuthenticated?(request: import('node:http').IncomingMessage): boolean;
  };
  readonly workspaceController: {
    create(request: {
      readonly path: string;
    }): Promise<{
      readonly workspace: {
        readonly workspaceId: string;
      };
    }>;
  };
  readonly sessionController: {
    create(request: {
      readonly workspaceId?: string;
      readonly sessionId?: string;
      readonly agentPreset?: string;
    }): Promise<{
      readonly sessionId: string;
    }>;
    prompt(request: {
      readonly requestId: string;
      readonly sessionId: string;
      readonly mode: 'queue' | 'steer';
      readonly content: readonly {
        readonly type: 'text';
        readonly text: string;
      }[];
      readonly clientTimeZone?: string;
    }, signal: AbortSignal): Promise<{
      readonly accepted: true;
    }>;
    list(request: object, signal: AbortSignal): Promise<{
      readonly items?: readonly unknown[];
    } | readonly unknown[]>;
    selectModel(request: {
      readonly sessionId: string;
      readonly provider: string;
      readonly model: string;
      readonly reasoningEffort?: string;
      readonly saveAsDefault: boolean;
    }): Promise<unknown>;
    cancel(request: {
      readonly sessionId: string;
    }): Promise<unknown>;
    modelCatalog(): unknown;
  };
  readonly sessions: {
    get(id: string): {
      snapshotEvents(): readonly {
        readonly type: string;
        readonly seq: number;
        readonly data: unknown;
      }[];
      readonly header?: {
        readonly cwd?: string;
        readonly agentPreset?: string;
      };
    } | undefined;
  };
  effect(execute: () => void | (() => void)): void;
  get(name: string): unknown;
  provide(name: string, value: unknown): void;
  on(name: 'user-questions/request', listener: (request: QuestionRequest, next: () => Promise<QuestionAnswer>) => Promise<QuestionAnswer>, options?: {
    readonly prepend?: boolean;
  }): (() => void) | void;
  on(name: 'session/created', listener: (session: {
    readonly header?: {
      readonly cwd?: string;
      readonly agentPreset?: string;
    };
  }) => void): (() => void) | void;
}
interface QuestionRequest {
  readonly questions?: unknown;
  readonly agent?: {
    readonly id?: unknown;
  };
  readonly signal?: AbortSignal;
}
interface QuestionAnswer {
  readonly answers: readonly {
    readonly id: string;
    readonly selected: readonly string[];
    readonly custom?: string;
  }[];
}
//#endregion
//#region src/index.d.ts
/** Cordis plugin name. */
declare const name = "orb-host";
/** Official services this plugin reads. Missing ones keep it pending. */
declare const inject: string[];
/**
 * Register preferences, Computer Use services, and settings routes, then start the ball.
 * Linux never starts the helper. `autoStart: false` and `ball-enabled.json` leave Computer Use in the main window.
 * @param ctx - host services named in {@link inject}.
 * @param config - patch config. `autoStart: false` skips the helper until settings turn it back on.
 */
declare function apply(ctx: OrbContext, config?: {
  autoStart?: boolean;
}): void;
//#endregion
export { type OrbContext, apply, inject, name };