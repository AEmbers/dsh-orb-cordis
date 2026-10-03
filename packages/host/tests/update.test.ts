import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProfileStore } from '../src/preferences.ts'
import { AUTO_CHECK_INTERVAL_MS, compareVersions, ownPackage, releaseTarballUrl, UpdateChecker, versionFromRelease } from '../src/update.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-update-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

let counter = 0
function store(): ProfileStore {
  counter += 1
  const path = join(root, `profile-${counter}`)
  mkdirSync(path, { recursive: true })
  return new ProfileStore(path)
}

/** A manager that records the spec it was handed and answers with a scripted result. */
function manager(result: Record<string, unknown> = { application: 'restart-required' }) {
  const specs: string[] = []
  return {
    specs,
    service: {
      async installBundle(spec: string) {
        specs.push(spec)
        return result
      },
    },
  }
}

function checker(options: {
  store: ProfileStore
  own?: { name: string; version: string } | undefined
  latest?: string | undefined
  result?: Record<string, unknown>
  notify?: (version: string) => void
}) {
  const fake = manager(options.result)
  const announced: string[] = []
  const update = new UpdateChecker({
    store: options.store,
    manager: () => fake.service,
    notify: (version) => { announced.push(version); options.notify?.(version) },
    fetchLatest: async () => options.latest,
    own: 'own' in options ? options.own : { name: 'dsh-orb', version: '0.1.0' },
  })
  return { update, announced, specs: fake.specs }
}

describe('update versions', () => {
  it('orders releases, patches, and prereleases', () => {
    assert.equal(compareVersions('0.2.0', '0.1.0'), 1)
    assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
    assert.equal(compareVersions('v0.1.0', '0.1.0'), 0)
    assert.equal(compareVersions('0.1.10', '0.1.9'), 1, 'numeric, not lexicographic')
    assert.equal(compareVersions('1.0', '1.0.0'), 0, 'a missing segment counts as zero')
    assert.equal(compareVersions('0.2.0-rc.2', '0.2.0'), -1, 'a prerelease precedes its release')
    assert.equal(compareVersions('0.2.0-rc.10', '0.2.0-rc.9'), 1)
    assert.equal(compareVersions('0.2.0-beta', '0.2.0-rc'), -1)
  })

  it('reads the installed manifest and refuses to guess one', () => {
    assert.deepEqual(ownPackage(), undefined, 'running from packages/host/lib finds no manifest')
  })

  it('derives the release tag and tarball address from a version', () => {
    assert.equal(versionFromRelease('{"tag_name":"plugin-v0.2.0"}'), '0.2.0')
    assert.equal(versionFromRelease('{"tag_name":"plugin-v0.2.0-rc.1"}'), '0.2.0-rc.1')
    assert.equal(versionFromRelease('{"name":"unrelated"}'), undefined)
    assert.equal(versionFromRelease('not json'), undefined)
    assert.equal(
      releaseTarballUrl('0.2.0'),
      'https://github.com/mini-yifan/dsh-orb-cordis/releases/download/plugin-v0.2.0/dsh-orb-0.2.0.tgz',
    )
    process.env.DSH_ORB_UPDATE_URL = 'http://127.0.0.1:9/downloads/dsh-orb-0.2.0.tgz'
    assert.equal(releaseTarballUrl('0.2.0'), 'http://127.0.0.1:9/downloads/dsh-orb-0.2.0.tgz')
    delete process.env.DSH_ORB_UPDATE_URL
  })
})

describe('update checker', () => {
  it('reports an available version once and remembers it', async () => {
    const profile = store()
    const { update, announced } = checker({ store: profile, latest: '0.2.0' })
    assert.equal(update.state().available, false, 'nothing is known before the first check')
    await update.check()
    assert.deepEqual(announced, ['0.2.0'])
    const state = update.state()
    assert.equal(state.currentVersion, '0.1.0')
    assert.equal(state.installedVersion, '0.1.0')
    assert.equal(state.latestVersion, '0.2.0')
    assert.equal(state.available, true)
    assert.equal(state.error, null)
    assert.equal(update.availableVersion(), '0.2.0')
    assert.deepEqual(profile.updateRecord(), {
      checkedAt: profile.updateRecord().checkedAt,
      latestVersion: '0.2.0',
      notifiedVersion: '0.2.0',
      autoCheck: true,
    })
    // A second check on the same version stays quiet, and a restart does too.
    await update.check()
    assert.deepEqual(announced, ['0.2.0'])
    const restarted = checker({ store: profile, latest: '0.2.0' })
    await restarted.update.check()
    assert.deepEqual(restarted.announced, [])
  })

  it('stays quiet when the published version is not newer', async () => {
    const profile = store()
    const { update, announced } = checker({ store: profile, latest: '0.1.0' })
    await update.check()
    assert.deepEqual(announced, [])
    assert.equal(update.state().available, false)
    assert.equal(update.state().error, null)
  })

  it('records a network failure without dropping the version it already knew', async () => {
    const profile = store()
    const first = checker({ store: profile, latest: '0.2.0' })
    await first.update.check()
    const offline = checker({ store: profile, latest: undefined })
    await offline.update.check(true)
    assert.equal(offline.update.state().error, 'network')
    assert.equal(offline.update.state().latestVersion, '0.2.0')
    assert.equal(offline.update.state().available, true)
  })

  it('throttles the automatic check but not a manual one', async () => {
    const profile = store()
    const { update } = checker({ store: profile, latest: '0.2.0' })
    await update.check()
    const checkedAt = profile.updateRecord().checkedAt
    assert.ok(Date.now() - checkedAt < AUTO_CHECK_INTERVAL_MS)
    // A fresh checker sees the same throttle: the timestamp is on disk, not in memory.
    let asked = 0
    const second = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => { asked += 1; return '0.3.0' },
      own: { name: 'dsh-orb', version: '0.1.0' },
    })
    await second.check()
    assert.equal(asked, 0)
    await second.check(true)
    assert.equal(asked, 1)
    assert.equal(second.state().latestVersion, '0.3.0')
  })

  it('skips the automatic check when the preference is off', async () => {
    const profile = store()
    profile.setUpdateRecord({ autoCheck: false })
    let asked = 0
    const update = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => { asked += 1; return '0.2.0' },
      own: { name: 'dsh-orb', version: '0.1.0' },
    })
    await update.check()
    assert.equal(asked, 0)
    assert.equal(update.state().autoCheck, false)
    await update.check(true)
    assert.equal(asked, 1)
    update.setAutoCheck(true)
    assert.equal(update.state().autoCheck, true)
  })

  it('runs the official installer against the release tarball', async () => {
    const profile = store()
    const { update, specs } = checker({ store: profile, latest: '0.2.0' })
    await update.check()
    await update.install()
    assert.deepEqual(specs, [
      'https://github.com/mini-yifan/dsh-orb-cordis/releases/download/plugin-v0.2.0/dsh-orb-0.2.0.tgz',
    ])
    const state = update.state()
    assert.equal(state.updating, false)
    assert.equal(state.error, null)
    assert.equal(state.installedVersion, '0.2.0')
    assert.equal(state.available, false, 'nothing is left to install')
    assert.equal(state.restartRequired, true, 'the running process still holds the old code')
    assert.equal(update.availableVersion(), null)
  })

  it('reports how an install failed instead of throwing', async () => {
    const profile = store()
    const failed = checker({
      store: profile,
      latest: '0.2.0',
      result: { application: 'failed', error: { code: 'incompatible-version' } },
    })
    await failed.update.check()
    await failed.update.install()
    assert.equal(failed.update.state().error, 'incompatible-version')
    assert.equal(failed.update.state().installedVersion, '0.1.0')
    assert.equal(failed.update.availableVersion(), '0.2.0', 'the offer survives for a retry')

    const blocked = checker({
      store: profile,
      latest: '0.2.0',
      result: { application: 'failed', pendingBuilds: ['koffi'] },
    })
    await blocked.update.check()
    await blocked.update.install()
    assert.equal(blocked.update.state().error, 'build-blocked')
    assert.deepEqual(blocked.update.state().pendingBuilds, ['koffi'])
  })

  it('keeps working without the official plugin manager', async () => {
    const profile = store()
    const update = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => '0.2.0',
      own: { name: 'dsh-orb', version: '0.1.0' },
    })
    await update.check()
    assert.equal(update.state().available, true, 'the notice needs no manager')
    assert.equal(update.state().canUpdate, false)
    await update.install()
    assert.equal(update.state().installedVersion, '0.1.0', 'nothing was installed')
  })

  it('has nothing to offer without a readable version', async () => {
    const profile = store()
    const update = new UpdateChecker({
      store: profile,
      manager: () => undefined,
      notify: () => {},
      fetchLatest: async () => '9.9.9',
      own: undefined,
    })
    await update.check()
    const state = update.state()
    assert.equal(state.currentVersion, '')
    assert.equal(state.available, false)
    assert.equal(state.canUpdate, false)
  })
})
