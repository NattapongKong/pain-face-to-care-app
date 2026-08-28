#!/usr/bin/env node
// Generates public/icons/icon-192.png and icon-512.png as real, valid PNGs:
// a solid navy (#1e3a5f, the app's primary color — tailwind.config.js
// theme.extend.colors.primary.DEFAULT) background with a white plus-sign
// drawn directly into the pixel buffer. No image library and no new
// dependency — the PNG container (signature/IHDR/IDAT/IEND, CRC32) is
// hand-assembled here and only node:zlib's deflateSync (stdlib) compresses
// the raw scanlines.
//
// Lives under scripts/ (alongside fetch-model.mjs) rather than public/ so it
// never ships verbatim into dist/ — public/ is copied to the build output
// as-is.
//
// Run with: node scripts/generate-icons.mjs
// Re-run after changing NAVY or the plus-sign proportions below to
// regenerate the committed PNGs.

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ICONS_DIR = join(__dirname, '..', 'public', 'icons')

const NAVY = [0x1e, 0x3a, 0x5f] // #1e3a5f
const WHITE = [0xff, 0xff, 0xff]

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function colorAt(x, y, size) {
  const thickness = Math.round(size * 0.22)
  const margin = Math.round(size * 0.16)
  const mid = size / 2
  const inVerticalBar =
    x >= mid - thickness / 2 && x < mid + thickness / 2 && y >= margin && y < size - margin
  const inHorizontalBar =
    y >= mid - thickness / 2 && y < mid + thickness / 2 && x >= margin && x < size - margin
  return inVerticalBar || inHorizontalBar ? WHITE : NAVY
}

function buildPng(size) {
  const stride = size * 3 + 1 // 1 filter-type byte + 3 bytes/px (RGB, no alpha)
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    const rowStart = y * stride
    raw[rowStart] = 0 // filter type 0 (None) for every scanline
    for (let x = 0; x < size; x++) {
      const [r, g, b] = colorAt(x, y, size)
      const px = rowStart + 1 + x * 3
      raw[px] = r
      raw[px + 1] = g
      raw[px + 2] = b
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0) // width
  ihdr.writeUInt32BE(size, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type 2 = truecolor (RGB)
  ihdr[10] = 0 // compression method
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace method

  const idat = deflateSync(raw)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

for (const size of [192, 512]) {
  const png = buildPng(size)
  const dest = join(ICONS_DIR, `icon-${size}.png`)
  writeFileSync(dest, png)
  console.log(`[generate-icons] wrote ${dest} (${png.length} bytes)`)
}
