// @vitest-environment jsdom
//
// Fix round MAJOR 2: the RecordDetailView rescue fix (BLOCKER) is reachable
// only by knowing a stranded record's exact URL unless RecordsView itself
// surfaces it somewhere — "even a fixed detail view is unreachable after
// navigating away". This pins that RecordsView adds a navigation-only,
// clearly-separated group for stranded (patientId:null) LOCAL records while
// linked, and that the group never appears when it has nothing to show.
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import RecordsView from '../../src/views/RecordsView.vue'
import { usePatientStore } from '../../src/stores/patientStore.js'
import { saveRecord } from '../../src/domain/repository.js'

function fakeRecord(id, patientId) {
  return {
    id,
    createdAt: '2026-08-25T10:00:00.000Z',
    patientId: patientId ?? null,
    synced: false,
    patient: { name: `ผู้ป่วย ${id}`, bed: '1A', datetime: '2026-08-25T10:00' },
    reported: { painScore: 5, location: '', vitalsChanged: false, vitalsDetail: '' },
    facial: {
      scores: { brow: 1, eyes: 1, noseCheek: 1, mouth: 1, overall: 1 },
      total: 5,
      source: 'manual',
      proposed: null,
    },
    result: { reportedSeverity: 'moderate', faceSeverity: 'moderate' },
    nursing: { band: 'moderate', items: [] },
    reassess: null,
    status: 'awaiting-reassess',
  }
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/records', name: 'records', component: RecordsView },
      { path: '/records/:id', name: 'record-detail', component: { template: '<div />' } },
      { path: '/assess', name: 'assess', component: { template: '<div />' } },
    ],
  })
}

async function mountRecords() {
  const router = makeRouter()
  router.push('/records')
  await router.isReady()
  return mount(RecordsView, { global: { plugins: [router] }, attachTo: document.body })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('RecordsView — stranded records group (fix round MAJOR 2)', () => {
  it('while linked, a stranded (patientId:null) local record shows in a separate "ไม่ได้ผูกกับผู้ป่วยรายใด" group and links to its detail page', async () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    saveRecord(fakeRecord('r1', null))

    const wrapper = await mountRecords()

    expect(wrapper.text()).toContain('ไม่ได้ผูกกับผู้ป่วยรายใด')
    const link = wrapper.findAll('a').find((a) => a.attributes('href')?.includes('/records/r1'))
    expect(link).toBeTruthy()

    wrapper.unmount()
  })

  it('the stranded group is absent while unlinked — those records already show in the normal unlinked list', async () => {
    saveRecord(fakeRecord('r1', null))

    const wrapper = await mountRecords()

    expect(wrapper.text()).not.toContain('ไม่ได้ผูกกับผู้ป่วยรายใด')

    wrapper.unmount()
  })

  it('the stranded group is absent while linked with no stranded records', async () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    saveRecord(fakeRecord('a1', 'A'))

    const wrapper = await mountRecords()

    expect(wrapper.text()).not.toContain('ไม่ได้ผูกกับผู้ป่วยรายใด')

    wrapper.unmount()
  })

  it('a record already attributed to a DIFFERENT patient never appears in the stranded group', async () => {
    usePatientStore().setContext({ patientId: 'A', token: 'tok-a' })
    saveRecord(fakeRecord('b1', 'B'))

    const wrapper = await mountRecords()

    expect(wrapper.text()).not.toContain('ไม่ได้ผูกกับผู้ป่วยรายใด')

    wrapper.unmount()
  })
})
