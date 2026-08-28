#!/usr/bin/env node
// Copies MediaPipe wasm assets into public/wasm/ and downloads the
// face_landmarker.task model into public/models/ so the built app is
// self-contained (no runtime CDN dependency), with a CDN fallback handled
// at runtime by src/facescan/landmarker.js if this step was skipped.
//
// Usage:
//   node scripts/fetch-model.mjs              # always fetch
//   node scripts/fetch-model.mjs --if-missing  # skip if already present
//
// Env:
//   SKIP_MODEL_FETCH=1  # no-op entirely (used in CI / build sandboxes)

import {
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  renameSync,
  unlinkSync,
  createWriteStream,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const MODEL_DEST = join(ROOT, 'public', 'models', 'face_landmarker.task')
const WASM_SRC = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const WASM_DEST = join(ROOT, 'public', 'wasm')

const ifMissing = process.argv.includes('--if-missing')

function log(msg) {
  console.log(`[fetch-model] ${msg}`)
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`Too many redirects fetching ${url}`))
      return
    }
    mkdirSync(dirname(dest), { recursive: true })

    // Download to a sibling .tmp file and only rename onto dest once fully
    // written, so a failed/interrupted download never truncates or
    // corrupts a pre-existing good model file at dest.
    const tmpDest = `${dest}.tmp`

    const cleanupTmp = () => {
      try {
        if (existsSync(tmpDest)) unlinkSync(tmpDest)
      } catch {
        // best-effort cleanup; ignore
      }
    }

    const req = https
      .get(url, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume()
          downloadFile(res.headers.location, dest, redirects + 1).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`))
          return
        }

        const file = createWriteStream(tmpDest)

        // A mid-body network drop emits 'error' on the response stream, not
        // just the request — without this handler that error is unhandled
        // and crashes the process.
        res.on('error', (err) => {
          file.close()
          cleanupTmp()
          reject(err)
        })

        file.on('error', (err) => {
          cleanupTmp()
          reject(err)
        })

        res.pipe(file)

        file.on('finish', () => {
          file.close(() => {
            try {
              renameSync(tmpDest, dest)
              resolve()
            } catch (err) {
              cleanupTmp()
              reject(err)
            }
          })
        })
      })
      .on('error', (err) => {
        cleanupTmp()
        reject(err)
      })

    // Guard against a hung connection (e.g. unroutable host) so this never
    // stalls predev/prebuild indefinitely.
    req.setTimeout(15000, () => {
      req.destroy(new Error(`Timed out downloading ${url}`))
    })
  })
}

async function copyWasm() {
  if (!existsSync(WASM_SRC)) {
    log(`wasm source not found at ${WASM_SRC} — run npm install first, skipping copy.`)
    return
  }
  if (ifMissing && existsSync(WASM_DEST) && readdirSync(WASM_DEST).length > 0) {
    log('public/wasm already populated, skipping copy (--if-missing).')
    return
  }
  mkdirSync(WASM_DEST, { recursive: true })
  cpSync(WASM_SRC, WASM_DEST, { recursive: true })
  log(`copied wasm assets to ${WASM_DEST}`)
}

async function fetchModel() {
  if (ifMissing && existsSync(MODEL_DEST)) {
    log('model already present, skipping download (--if-missing).')
    return
  }
  log(`downloading model from ${MODEL_URL} ...`)
  await downloadFile(MODEL_URL, MODEL_DEST)
  log(`saved model to ${MODEL_DEST}`)
}

async function main() {
  if (process.env.SKIP_MODEL_FETCH === '1') {
    log('SKIP_MODEL_FETCH=1 set, skipping entirely.')
    return
  }
  await copyWasm()
  try {
    await fetchModel()
  } catch (err) {
    // Non-fatal: an offline machine (or any download failure) must never
    // abort the npm lifecycle. src/facescan/landmarker.js falls back to the
    // official Google Storage CDN URL at runtime when no local model exists.
    log(
      `WARNING: model download failed (${err.message}). The app will fall back to the CDN model URL at runtime. Continuing.`,
    )
  }
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    // Belt-and-suspenders: even an unexpected error here (e.g. copyWasm
    // failing) must not fail predev/prebuild.
    console.error('[fetch-model] unexpected error:', err)
    log('WARNING: continuing without local model/wasm assets; runtime CDN fallback covers this.')
    process.exit(0)
  })
