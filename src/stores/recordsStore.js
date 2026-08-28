import { defineStore } from 'pinia'
import * as repository from '../domain/repository.js'
import { recordsToCsv, recordsToJson, downloadFile } from '../domain/csv.js'
import { useSyncStore } from './syncStore.js'
import { usePatientStore } from './patientStore.js'

function pad(n) {
  return String(n).padStart(2, '0')
}

function todayStamp() {
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

// Cross-store access is resolved lazily (only INSIDE an action call, never
// at module load) — matches the existing store idiom (see
// assessmentStore.js) that avoids touching another store before pinia is
// installed.
function defaultContextId() {
  const patientStore = usePatientStore()
  return patientStore.linked ? patientStore.patientId : null
}

export const useRecordsStore = defineStore('records', {
  state: () => ({
    records: [],
  }),

  actions: {
    load() {
      this.records = repository.loadRecords()
      return this.records
    },

    get(id) {
      return this.records.find((r) => r.id === id) ?? null
    },

    remove(id) {
      repository.deleteRecord(id)
      this.load()
    },

    /**
     * The spec §8 visibility filter, the no-leak core: local records whose
     * `(patientId ?? null)` matches `contextId` exactly (legacy records with
     * no patientId field count as null, same as an explicit null). When
     * `contextId` is a real patient id (linked mode), also merges in any
     * record `syncStore.serverRecords` knows about that ISN'T already
     * present locally — deduped by id, the LOCAL copy always wins on a
     * collision (it may be newer than what the server last saw), and
     * anything added purely from the server is flagged `serverOnly: true`
     * so the UI can render it read-only (no delete/reassess action can act
     * on data this device never actually stored). Unlinked (`contextId ===
     * null`) never merges server data — there is no authenticated token to
     * have fetched it with in the first place. Every server candidate is
     * ALSO checked against its OWN `(patientId ?? null)` before merging
     * (review round 1 BLOCKER 1(b)) — `syncStore.serverRecords` is reset on
     * every context switch (router.js) but is still ordinary reactive state
     * that can transiently hold a stale prior patient's rows (e.g. the
     * brief window before a fresh pull resolves); this filter is the
     * actual no-leak guarantee, not a convenience — it must hold even if
     * resetServer() were ever skipped or raced. Sorted newest-first by
     * createdAt.
     * @param {string|null} contextId
     * @returns {object[]}
     */
    visibleRecords(contextId) {
      const local = this.records.filter((r) => (r.patientId ?? null) === contextId)

      if (contextId !== null) {
        const syncStore = useSyncStore()
        const localIds = new Set(local.map((r) => r.id))
        for (const serverRecord of syncStore.serverRecords ?? []) {
          if (
            serverRecord &&
            typeof serverRecord.id === 'string' &&
            (serverRecord.patientId ?? null) === contextId &&
            !localIds.has(serverRecord.id)
          ) {
            local.push({ ...serverRecord, serverOnly: true })
          }
        }
      }

      return local.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    },

    /**
     * Exports exactly the currently visible (scoped) list — never the raw
     * unfiltered `records` state. Defaults to the CURRENT patient context so
     * every existing call site keeps working unchanged; pass `contextId`
     * explicitly to export a specific scope (e.g. from a test).
     * @param {string|null} [contextId]
     */
    exportCsv(contextId = defaultContextId()) {
      const csv = recordsToCsv(this.visibleRecords(contextId))
      downloadFile(`painface-records-${todayStamp()}.csv`, csv, 'text/csv;charset=utf-8')
      return csv
    },

    /** @param {string|null} [contextId] */
    exportJson(contextId = defaultContextId()) {
      const json = recordsToJson(this.visibleRecords(contextId))
      downloadFile(`painface-records-${todayStamp()}.json`, json, 'application/json;charset=utf-8')
      return json
    },
  },
})
