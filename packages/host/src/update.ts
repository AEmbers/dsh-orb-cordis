/**
 * Update check and one-click upgrade for the installed bundle.
 * The npm registry is the distribution channel: npmmirror answers first because
 * github.com and the npm registry itself are unreliable from mainland China.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { ProfileStore } from './preferences.ts'

/** Registries asked in turn. Both answer `/<name>/latest` as plain JSON without credentials. */
export const UPDATE_REGISTRIES = [
  'https://registry.npmmirror.com',
  'https://registry.npmjs.org',
]

/** How long a remembered answer stays fresh for the automatic check. */
export const AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000

/** Delay before the first automatic check: the official host needs the network at boot. */
export const FIRST_CHECK_DELAY_MS = 20 * 1000

const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000

/** Answer a host without an updater gives: the settings page then hides the whole card. */
export const EMPTY_UPDATE_STATE: UpdateState = {
  currentVersion: '',
  installedVersion: '',
  latestVersion: null,
  available: false,
  checking: false,
  updating: false,
  canUpdate: false,
  autoCheck: false,
  checkedAt: null,
  restartRequired: false,
  error: null,
  pendingBuilds: [],
}

/** What the settings page renders. `currentVersion` is the code this process runs. */
export interface UpdateState {
  currentVersion: string
  /** Version on disk now; differs from {@link currentVersion} after an upgrade until restart. */
  installedVersion: string
  latestVersion: string | null
  available: boolean
  checking: boolean
  updating: boolean
  canUpdate: boolean
  autoCheck: boolean
  checkedAt: number | null
  restartRequired: boolean
  error: string | null
  pendingBuilds: string[]
}

/** The package manifest next to the built host. */
export interface OwnPackage {
  readonly name: string
  readonly version: string
}

/** The slice of the official `pluginManager` service this plugin uses. */
export interface PluginManager {
  installBundle(spec: string, options?: {
    enabled?: boolean
    requestId?: string
    approvedBuilds?: string[]
  }): Promise<InstallResult>
}

export interface InstallResult {
  readonly changed?: boolean
  readonly application?: string
  readonly error?: { readonly code?: string; readonly diagnostic?: string }
  readonly pendingBuilds?: readonly string[]
  readonly bundle?: string
}

export interface UpdateDeps {
  readonly store: ProfileStore
  /** Official service, read live because it mounts after us. */
  manager(): unknown
  /** Announce a newly published version on the ball, once per version. */
  notify(version: string): void
  /** Test seam: newest published version, or undefined when no registry answers. */
  fetchLatest?(name: string): Promise<string | undefined>
  /** Test seam: the installed manifest. */
  own?: OwnPackage | undefined
}

/**
 * Read the installed manifest.
 * The path assumes the assembled layout: `dist/host/index.js` next to the package's
 * `package.json`, which holds both in the profile's `node_modules/dsh-orb` and in a
 * `link:`ed source checkout. Running from `packages/host/lib` finds nothing, so callers
 * treat an unknown version as "no update UI".
 */
export function ownPackage(url: string = import.meta.url): OwnPackage | undefined {
  let raw: string
  try {
    raw = readFileSync(new URL('../../package.json', url), 'utf8')
  } catch {
    return undefined
  }
  try {
    const manifest = JSON.parse(raw) as { name?: unknown; version?: unknown }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return undefined
    if (manifest.name === '' || manifest.version === '') return undefined
    return { name: manifest.name, version: manifest.version }
  } catch {
    return undefined
  }
}

/** Order two dotted versions. A prerelease sorts below the release it precedes. */
export function compareVersions(left: string, right: string): number {
  const a = splitVersion(left)
  const b = splitVersion(right)
  for (let index = 0; index < Math.max(a.main.length, b.main.length); index += 1) {
    const one = a.main[index] ?? 0
    const other = b.main[index] ?? 0
    if (one !== other) return one < other ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return comparePrerelease(a.pre, b.pre)
}

function isPluginManager(value: unknown): value is PluginManager {
  return typeof value === 'object' && value !== null
    && typeof (value as { installBundle?: unknown }).installBundle === 'function'
}

/**
 * Checks the registry for a newer version and runs the official installer.
 * Every failure stays inside this class: the update path must never break the ball.
 */
export class UpdateChecker {
  private readonly store: ProfileStore
  private readonly deps: UpdateDeps
  private readonly own: OwnPackage | undefined
  private installed: string
  private latest: string | null
  private checking = false
  private updating = false
  private error: string | null = null
  private pendingBuilds: string[] = []
  private restartRequired = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private interval: ReturnType<typeof setInterval> | undefined

  constructor(deps: UpdateDeps) {
    this.deps = deps
    this.store = deps.store
    this.own = 'own' in deps ? deps.own : ownPackage()
    this.installed = this.own?.version ?? ''
    this.latest = this.store.updateRecord().latestVersion || null
  }

  state(): UpdateState {
    const latest = this.latest
    const installed = this.installed
    return {
      currentVersion: this.own?.version ?? '',
      installedVersion: installed,
      latestVersion: latest,
      available: this.available(),
      checking: this.checking,
      updating: this.updating,
      canUpdate: this.own !== undefined && isPluginManager(this.deps.manager()),
      autoCheck: this.store.updateRecord().autoCheck,
      checkedAt: this.store.updateRecord().checkedAt || null,
      restartRequired: this.restartRequired,
      error: this.error,
      pendingBuilds: [...this.pendingBuilds],
    }
  }

  /** Version waiting to be installed, when the check found one. */
  availableVersion(): string | null {
    return this.available() ? this.latest : null
  }

  /** Schedule the automatic checks and return the disposer. */
  start(): () => void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.check()
    }, FIRST_CHECK_DELAY_MS)
    this.timer.unref()
    this.interval = setInterval(() => { void this.check() }, PERIODIC_CHECK_MS)
    this.interval.unref()
    return () => {
      if (this.timer !== undefined) clearTimeout(this.timer)
      if (this.interval !== undefined) clearInterval(this.interval)
      this.timer = undefined
      this.interval = undefined
    }
  }

  /**
   * Ask every registry in turn for the newest published version.
   * The automatic call is throttled by {@link AUTO_CHECK_INTERVAL_MS}; `/update/check` is not.
   */
  async check(manual = false): Promise<void> {
    if (this.checking || this.updating || this.own === undefined) return
    const record = this.store.updateRecord()
    if (!manual && !record.autoCheck) return
    if (!manual && Date.now() - record.checkedAt < AUTO_CHECK_INTERVAL_MS) return
    this.checking = true
    try {
      const latest = await this.fetch()
      if (latest === undefined) {
        this.error = 'network'
        return
      }
      this.latest = latest
      this.error = null
      const announce = compareVersions(latest, this.installed) > 0 && record.notifiedVersion !== latest
      this.store.setUpdateRecord({
        checkedAt: Date.now(),
        latestVersion: latest,
        ...announce ? { notifiedVersion: latest } : {},
      })
      if (announce) this.deps.notify(latest)
    } finally {
      this.checking = false
    }
  }

  /**
   * Install the version the check found through the official plugin manager.
   * The manager owns the profile lock, the registry fallback and the manifest restore.
   */
  async install(approvedBuilds?: string[]): Promise<void> {
    const version = this.availableVersion()
    const manager = this.deps.manager()
    if (version === null || this.updating || !isPluginManager(manager) || this.own === undefined) return
    this.updating = true
    this.error = null
    this.pendingBuilds = []
    try {
      const result = await manager.installBundle(`${this.own.name}@${version}`, {
        requestId: `dsh-orb-update-${Date.now()}`,
        ...approvedBuilds === undefined ? {} : { approvedBuilds },
      })
      if (result.application === 'failed') {
        this.error = result.error?.code ?? 'operation-error'
        this.pendingBuilds = result.pendingBuilds === undefined ? [] : [...result.pendingBuilds]
        if (this.pendingBuilds.length > 0) this.error = 'build-blocked'
        return
      }
      this.installed = version
      this.latest = version
      this.restartRequired = compareVersions(version, this.own.version) !== 0
      this.store.setUpdateRecord({ latestVersion: version, notifiedVersion: version, checkedAt: Date.now() })
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.updating = false
    }
  }

  setAutoCheck(enabled: boolean): void {
    this.store.setUpdateRecord({ autoCheck: enabled })
  }

  private available(): boolean {
    return this.own !== undefined && this.latest !== null && compareVersions(this.latest, this.installed) > 0
  }

  private async fetch(): Promise<string | undefined> {
    const own = this.own
    if (own === undefined) return undefined
    if (this.deps.fetchLatest !== undefined) return this.deps.fetchLatest(own.name)
    for (const registry of registries()) {
      const body = await curlText(`${registry}/${own.name}/latest`)
      const version = body === undefined ? undefined : versionFrom(body)
      if (version !== undefined) return version
    }
    return undefined
  }
}

function splitVersion(value: string): { main: number[]; pre: string } {
  const trimmed = value.trim().replace(/^v/, '')
  const dash = trimmed.indexOf('-')
  const head = dash === -1 ? trimmed : trimmed.slice(0, dash)
  const pre = dash === -1 ? '' : trimmed.slice(dash + 1)
  const main = head.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  })
  return { main, pre }
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split('.')
  const b = right.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = a[index]
    const other = b[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (one === other) continue
    const oneNumber = /^\d+$/.test(one) ? Number.parseInt(one, 10) : undefined
    const otherNumber = /^\d+$/.test(other) ? Number.parseInt(other, 10) : undefined
    if (oneNumber !== undefined && otherNumber !== undefined) return oneNumber < otherNumber ? -1 : 1
    if (oneNumber !== undefined) return -1
    if (otherNumber !== undefined) return 1
    return one < other ? -1 : 1
  }
  return 0
}

function registries(): string[] {
  const configured = process.env.DSH_ORB_UPDATE_REGISTRY?.trim()
  if (configured !== undefined && configured !== '') return [configured.replace(/\/+$/, '')]
  return UPDATE_REGISTRIES
}

function versionFrom(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * `DSH_ORB_UPDATE_LATEST` answers the check without a network round trip: a test switch
 * for the update UI, and the only way to see it before the first npm release.
 */
async function curlText(url: string): Promise<string | undefined> {
  const forced = process.env.DSH_ORB_UPDATE_LATEST?.trim()
  if (forced !== undefined && forced !== '') return JSON.stringify({ version: forced })
  return new Promise((resolve) => {
    const child = spawn('curl', [
      '-fsSL',
      '--proto', '=https',
      '--proto-redir', '=https',
      '--connect-timeout', '5',
      '--max-time', '15',
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.resume()
    child.once('error', () => { resolve(undefined) })
    child.once('exit', (code) => {
      resolve(code === 0 ? Buffer.concat(out).toString('utf8') : undefined)
    })
  })
}
