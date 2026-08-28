// MediaPipe FaceLandmarker service: an explicit attempt ladder over
// (wasm source, model source) so a real failure at any rung falls through
// to the next, and exposes a minimal detect()/close(). Runtime module —
// not unit-tested (no browser/WASM in vitest's node env); reviewed +
// exercised at live integration per plan Task 3. Spec §5.1.

import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision'

const LOCAL_WASM_BASE = '/wasm'
// Pinned to the EXACT installed @mediapipe/tasks-vision version (see
// node_modules/@mediapipe/tasks-vision/package.json) rather than a semver
// range — the JS loader and the .wasm binary it fetches must come from the
// same build, and a range like "@0.10" can resolve to a newer JS loader
// than the WASM it pairs with mid-flight.
const CDN_WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'

const LOCAL_MODEL_PATH = '/models/face_landmarker.task'
// Same URL scripts/fetch-model.mjs downloads at setup time — official
// Google Storage CDN, open model (Apache-2.0), used at runtime as fallback.
const CDN_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

function landmarkerOptions(modelAssetPath) {
  return {
    baseOptions: { modelAssetPath },
    runningMode: 'VIDEO',
    outputFaceBlendshapes: true,
    numFaces: 1,
  }
}

// FilesetResolver.forVisionTasks() does no I/O of its own and effectively
// never rejects — the real success/failure signal for a given (wasm, model)
// pairing only shows up once FaceLandmarker.createFromOptions() actually
// tries to instantiate the WASM graph and load the model. So each rung
// below re-resolves the fileset for the wasm source it names and attempts
// creation with it; a throw at either step just moves to the next rung.
// `source` reflects the MODEL actually used (local vs CDN), independent of
// which wasm source ended up serving it.
const ATTEMPTS = [
  { wasmBase: LOCAL_WASM_BASE, modelPath: LOCAL_MODEL_PATH, source: 'local' },
  { wasmBase: LOCAL_WASM_BASE, modelPath: CDN_MODEL_URL, source: 'cdn' },
  { wasmBase: CDN_WASM_BASE, modelPath: CDN_MODEL_URL, source: 'cdn' },
]

function detectorFor(landmarker) {
  return function detect(video, tsMs) {
    const result = landmarker.detectForVideo(video, tsMs)
    const categories = result?.faceBlendshapes?.[0]?.categories
    if (!categories || categories.length === 0) return null

    const blendshapes = {}
    for (const category of categories) {
      blendshapes[category.categoryName] = category.score
    }
    return blendshapes
  }
}

/**
 * @returns {Promise<{
 *   detect: (video: HTMLVideoElement, tsMs: number) => Record<string, number>|null,
 *   close: () => void,
 *   source: 'local'|'cdn'
 * }>}
 */
export async function createLandmarker() {
  let lastError = null

  for (const attempt of ATTEMPTS) {
    try {
      const fileset = await FilesetResolver.forVisionTasks(attempt.wasmBase)
      const landmarker = await FaceLandmarker.createFromOptions(
        fileset,
        landmarkerOptions(attempt.modelPath),
      )
      return {
        source: attempt.source,
        detect: detectorFor(landmarker),
        close() {
          landmarker.close()
        },
      }
    } catch (err) {
      lastError = err
    }
  }

  throw lastError ?? new Error('Failed to create FaceLandmarker from any known source')
}
