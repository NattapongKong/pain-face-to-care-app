// Shared boot-time / re-scan sync flow (review round 2 MAJOR N2). Both
// main.js's boot chain and router.js's /p/:pid/:token handler need the
// EXACT same three steps: init (idempotent; awaited so `configured` is
// reliably known before pulling, on every call path), pull for whichever
// patient is currently linked, then persist the resolved
// displayName/bed/baseline (spec §5 — still the ONE wiring point, R35).
// Round 1 had two independently hand-written copies of this chain, which
// is exactly how they drifted apart (the "displayName never lands after a
// scan" bug this round fixes) — one function, one place to get it right.

/**
 * @param {ReturnType<import('./syncStore.js').useSyncStore>} syncStore
 * @param {ReturnType<import('./patientStore.js').usePatientStore>} patientStore
 */
export async function pullForPatient(syncStore, patientStore) {
  // init() is called UNCONDITIONALLY, before the linked check: syncStore
  // must initialize (load config, wire online/offline listeners, attempt a
  // backlog flush) on every boot regardless of whether THIS device
  // currently carries a patient context — flush() sends each queued item
  // under ITS OWN stored patientId/token, not the live context, so an
  // unlinked device can still have real backlog work to do. init() is
  // idempotent (safe/cheap to call again from the /p route handler after
  // main.js's own boot call already ran it).
  await syncStore.init()
  if (!patientStore.linked) return

  // review round 2 MAJOR N1(b): capture the context this call is FOR
  // before awaiting the pull. If patientStore has moved on to a DIFFERENT
  // patient by the time it settles (another scan arrived mid-flight),
  // this call's resolved serverDisplayName must never be persisted onto
  // patientStore for the wrong patient. syncStore.pull()'s own `pullSeq`
  // guard (N1a) independently protects serverRecords/serverDisplayName
  // themselves from a stale WRITE inside the store; this is the
  // belt-and-braces check at the CALL SITE that stops a (correctly,
  // by N1a, not-yet-overwritten) stale serverDisplayName from being
  // persisted under the wrong patient id.
  const ctxId = patientStore.patientId
  const pulled = await syncStore.pull({ patientId: patientStore.patientId, token: patientStore.token })

  if (patientStore.patientId !== ctxId) return
  // Fix round (MAJOR): gate on pull()'s own response-ownership return value,
  // NOT on `serverDisplayName` truthiness. syncStore.pull() leaves
  // server*/serverDisplayName UNTOUCHED on an unauthorized or network
  // failure — a truthiness check only "worked" while something ELSE (e.g.
  // a resetServer() call on unlink) happened to have already cleared that
  // leftover state from an EARLIER successful pull for a DIFFERENT patient.
  // Without that reset in between, a truthy but STALE serverDisplayName
  // would let this patient's failed pull copy the PREVIOUS patient's
  // bed/baseline onto them — a real cross-patient data leak. `pulled` is
  // true only when THIS call's settle actually wrote server* (see
  // syncStore.pull()'s doc comment), so it is immune to that staleness
  // regardless of what else has or hasn't reset syncStore in between. This
  // also fixes a related pin: a successful pull with a legitimately empty
  // displayName (e.g. a hand-edited Sheet row) must still copy bed/baseline
  // — `pulled` doesn't care what displayName's value is, only whether the
  // pull itself succeeded.
  if (pulled) {
    patientStore.applyServerInfo({
      displayName: String(syncStore.serverDisplayName),
      bed: syncStore.serverBed,
      baseline: syncStore.serverBaseline,
    })
  }
}
