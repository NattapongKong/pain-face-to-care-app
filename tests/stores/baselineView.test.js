// Baseline banking save-flow (spec §7, plan Task 6). `saveBaselineFlow` is
// exported from BaselineView.vue's plain <script> block (merged into the
// same module as its <script setup>/default export by the Vue SFC
// compiler) precisely so this logic is testable without mounting the view,
// the camera, or useFaceScan at all — every collaborator (client call,
// store write-through) is injected, not imported/mocked.
import { describe, it, expect, vi } from 'vitest'
import { saveBaselineFlow } from '../../src/views/BaselineView.vue'

const SYNC_URL = 'https://script.google.com/macros/s/deadbeef/exec'
const BASELINE = { browDownLeft: 0.12, jawOpen: 0.03 }

describe('BaselineView save flow — happy path', () => {
  it('POSTs via saveBaselineRemote, writes through locally, and reports ok:true', async () => {
    const saveBaselineRemote = vi.fn().mockResolvedValue({ ok: true })
    const setBaseline = vi.fn()

    const result = await saveBaselineFlow({
      linked: true,
      syncUrl: SYNC_URL,
      patientId: 'P-1',
      token: 'tok-1',
      baseline: BASELINE,
      saveBaselineRemote,
      setBaseline,
    })

    expect(saveBaselineRemote).toHaveBeenCalledTimes(1)
    expect(saveBaselineRemote).toHaveBeenCalledWith(SYNC_URL, { patientId: 'P-1', token: 'tok-1', baseline: BASELINE })
    expect(setBaseline).toHaveBeenCalledTimes(1)
    expect(setBaseline).toHaveBeenCalledWith(BASELINE)
    expect(result).toEqual({ ok: true })
  })
})

describe('BaselineView save flow — failure path', () => {
  it('a thrown SyncError still writes through locally and reports ok:false', async () => {
    class SyncError extends Error {
      constructor(code) {
        super(code)
        this.code = code
      }
    }
    const saveBaselineRemote = vi.fn().mockRejectedValue(new SyncError('server-error'))
    const setBaseline = vi.fn()

    const result = await saveBaselineFlow({
      linked: true,
      syncUrl: SYNC_URL,
      patientId: 'P-1',
      token: 'tok-1',
      baseline: BASELINE,
      saveBaselineRemote,
      setBaseline,
    })

    expect(setBaseline).toHaveBeenCalledTimes(1)
    expect(setBaseline).toHaveBeenCalledWith(BASELINE)
    expect(result).toEqual({ ok: false })
  })

  it('a plain network rejection also writes through locally and reports ok:false', async () => {
    const saveBaselineRemote = vi.fn().mockRejectedValue(new Error('failed to reach the sync server'))
    const setBaseline = vi.fn()

    const result = await saveBaselineFlow({
      linked: true,
      syncUrl: SYNC_URL,
      patientId: 'P-1',
      token: 'tok-1',
      baseline: BASELINE,
      saveBaselineRemote,
      setBaseline,
    })

    expect(setBaseline).toHaveBeenCalledWith(BASELINE)
    expect(result).toEqual({ ok: false })
  })

  // Plan Task 6 step 4: unconfigured sync (no syncUrl) is treated as the
  // SAME failure path — local save + warning — never a dead button. The
  // remote call must not even be attempted with an empty syncUrl.
  it('an unconfigured syncUrl skips the remote call, still writes through locally, and reports ok:false', async () => {
    const saveBaselineRemote = vi.fn()
    const setBaseline = vi.fn()

    const result = await saveBaselineFlow({
      linked: true,
      syncUrl: '',
      patientId: 'P-1',
      token: 'tok-1',
      baseline: BASELINE,
      saveBaselineRemote,
      setBaseline,
    })

    expect(saveBaselineRemote).not.toHaveBeenCalled()
    expect(setBaseline).toHaveBeenCalledWith(BASELINE)
    expect(result).toEqual({ ok: false })
  })
})

// Fix round MAJOR: a direct/typed/bookmarked navigation to #/baseline while
// UNLINKED (or an unlink that lands mid-flight, e.g. ออกจากผู้ป่วย in another
// tab, before the save actually runs) must never POST with null identifiers
// nor claim a local save that never happened — patientStore.setBaseline()
// itself skips persistence when unlinked, so the "บันทึกในเครื่องแล้ว…" copy
// would be an outright lie in that state. The flow must refuse outright:
// no saveBaselineRemote call, no setBaseline call, and a result the caller
// can render as an honest, DISTINCT state (never the generic 'failed' one).
describe('BaselineView save flow — unlinked refusal', () => {
  it('refuses outright when not linked: no remote POST, no local write-through, distinct result', async () => {
    const saveBaselineRemote = vi.fn()
    const setBaseline = vi.fn()

    const result = await saveBaselineFlow({
      linked: false,
      syncUrl: SYNC_URL,
      patientId: null,
      token: null,
      baseline: BASELINE,
      saveBaselineRemote,
      setBaseline,
    })

    expect(saveBaselineRemote).not.toHaveBeenCalled()
    expect(setBaseline).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unlinked')
  })

  it('refuses outright when not linked even with no syncUrl configured (never falls into the generic unconfigured-failure branch)', async () => {
    const saveBaselineRemote = vi.fn()
    const setBaseline = vi.fn()

    const result = await saveBaselineFlow({
      linked: false,
      syncUrl: '',
      patientId: null,
      token: null,
      baseline: BASELINE,
      saveBaselineRemote,
      setBaseline,
    })

    expect(saveBaselineRemote).not.toHaveBeenCalled()
    expect(setBaseline).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, reason: 'unlinked' })
  })
})

describe('BaselineView save flow — retry', () => {
  it('retrying re-POSTs the SAME vector and can succeed after an initial failure', async () => {
    const saveBaselineRemote = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ ok: true })
    const setBaseline = vi.fn()

    const first = await saveBaselineFlow({
      linked: true,
      syncUrl: SYNC_URL,
      patientId: 'P-1',
      token: 'tok-1',
      baseline: BASELINE,
      saveBaselineRemote,
      setBaseline,
    })
    expect(first).toEqual({ ok: false })

    // Retry: the caller (BaselineView) re-invokes the flow with the exact
    // same captured vector — never a re-capture.
    const second = await saveBaselineFlow({
      linked: true,
      syncUrl: SYNC_URL,
      patientId: 'P-1',
      token: 'tok-1',
      baseline: BASELINE,
      saveBaselineRemote,
      setBaseline,
    })
    expect(second).toEqual({ ok: true })

    expect(saveBaselineRemote).toHaveBeenCalledTimes(2)
    expect(saveBaselineRemote.mock.calls[0]).toEqual([SYNC_URL, { patientId: 'P-1', token: 'tok-1', baseline: BASELINE }])
    expect(saveBaselineRemote.mock.calls[1]).toEqual([SYNC_URL, { patientId: 'P-1', token: 'tok-1', baseline: BASELINE }])
    // Local write-through happens on EVERY attempt, failed or not.
    expect(setBaseline).toHaveBeenCalledTimes(2)
    expect(setBaseline).toHaveBeenNthCalledWith(1, BASELINE)
    expect(setBaseline).toHaveBeenNthCalledWith(2, BASELINE)
  })

  it('a retry that fails again still writes through locally and reports ok:false', async () => {
    const saveBaselineRemote = vi.fn().mockRejectedValue(new Error('still down'))
    const setBaseline = vi.fn()

    await saveBaselineFlow({
      linked: true,
      syncUrl: SYNC_URL,
      patientId: 'P-1',
      token: 'tok-1',
      baseline: BASELINE,
      saveBaselineRemote,
      setBaseline,
    })
    const retryResult = await saveBaselineFlow({
      linked: true,
      syncUrl: SYNC_URL,
      patientId: 'P-1',
      token: 'tok-1',
      baseline: BASELINE,
      saveBaselineRemote,
      setBaseline,
    })

    expect(retryResult).toEqual({ ok: false })
    expect(setBaseline).toHaveBeenCalledTimes(2)
  })
})
