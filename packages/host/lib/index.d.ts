//#region src/orb.d.ts
/**
 * NDJSON control plane for the ball, plus the Computer Use session it talks to.
 * The helper never calls the official HTTP API. Messages arrive here and this process calls the host services.
 */
/** Host services the plugin injects. Shapes match the official 0.1.7-rc.2 controllers. */
interface OrbContext {
  readonly webServer: {
    readonly port: number;
  };
  readonly connection: {
    authenticatedUrl(baseUrl: string): string;
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
  };
  readonly sessions: {
    get(id: string): {
      snapshotEvents(): readonly {
        readonly type: string;
        readonly seq: number;
        readonly data: unknown;
      }[];
    } | undefined;
  };
  effect(execute: () => void | (() => void)): void;
  on(name: 'user-questions/request', listener: (request: QuestionRequest, next: () => Promise<QuestionAnswer>) => Promise<QuestionAnswer>, options?: {
    readonly prepend?: boolean;
  }): (() => void) | void;
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
 * Log the web port, then start the ball unless this is Linux or autoStart is off.
 * @param ctx - host services named in {@link inject}.
 * @param config - patch config. `autoStart: false` leaves Computer Use in the main window only.
 */
declare function apply(ctx: OrbContext, config?: {
  autoStart?: boolean;
}): void;
//#endregion
export { type OrbContext, apply, inject, name };