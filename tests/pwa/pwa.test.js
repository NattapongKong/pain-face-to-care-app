import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { registerPainfacePwa } from '../../src/pwa.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, '../../public')

describe('public/manifest.webmanifest', () => {
  const manifest = JSON.parse(readFileSync(join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf-8'))

  it('parses as JSON with the required PWA fields', () => {
    expect(manifest.name).toBe('PAIN FACE to Care')
    expect(manifest.short_name).toBe('PainFace')
    expect(manifest.start_url).toBe('./')
    expect(manifest.display).toBe('standalone')
    expect(manifest.theme_color).toBe('#1e3a5f')
    expect(manifest.background_color).toBe('#1e3a5f')
    expect(manifest.lang).toBe('th')
    expect(Array.isArray(manifest.icons)).toBe(true)
    expect(manifest.icons.length).toBeGreaterThan(0)
  })

  it('includes an SVG icon covering both "any" and "maskable" purpose', () => {
    const svgPurposes = manifest.icons
      .filter((icon) => icon.type === 'image/svg+xml')
      .flatMap((icon) => icon.purpose.split(/\s+/))
    expect(svgPurposes).toContain('any')
    expect(svgPurposes).toContain('maskable')
  })

  it('references only icon files that actually exist under public/', () => {
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) {
      const path = join(PUBLIC_DIR, icon.src.replace(/^\.\//, ''))
      expect(existsSync(path), `${icon.src} should exist`).toBe(true)
    }
  })
})

describe('public/icons/*.png', () => {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  function readDimensions(path) {
    const buf = readFileSync(path)
    expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    // IHDR is always the first chunk, immediately after the 8-byte
    // signature: 4-byte length, 4-byte "IHDR" type, then width/height as
    // two big-endian uint32s.
    expect(buf.toString('ascii', 12, 16)).toBe('IHDR')
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  it.each([
    ['icon-192.png', 192],
    ['icon-512.png', 512],
  ])('%s is a real PNG sized %ix%i', (filename, size) => {
    const { width, height } = readDimensions(join(PUBLIC_DIR, 'icons', filename))
    expect(width).toBe(size)
    expect(height).toBe(size)
  })
})

describe('public/icons/icon.svg', () => {
  it('is well-formed SVG with a navy background matching the theme token', () => {
    const svg = readFileSync(join(PUBLIC_DIR, 'icons', 'icon.svg'), 'utf-8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('#1e3a5f')
  })
})

describe('public/sw.js', () => {
  const source = readFileSync(join(PUBLIC_DIR, 'sw.js'), 'utf-8')

  it('contains no syntax errors (compiles as a classic script)', () => {
    expect(() => new Function(source)).not.toThrow()
  })

  it('is a classic script, not an ES module (no import/export statements)', () => {
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/^\s*export\s/m)
  })

  it('names a versioned cache and precaches the offline shell', () => {
    expect(source).toMatch(/CACHE_NAME\s*=\s*['"]painface-v\d+['"]/)
    expect(source).toContain("'./index.html'")
  })
})

describe('src/pwa.js — registerPainfacePwa', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('does not register a service worker when PROD is false (dev)', () => {
    vi.stubEnv('PROD', false)
    const register = vi.fn()
    vi.stubGlobal('navigator', { serviceWorker: { register } })

    registerPainfacePwa()

    expect(register).not.toHaveBeenCalled()
  })

  it('registers ./sw.js when PROD is true and serviceWorker is supported', () => {
    vi.stubEnv('PROD', true)
    const register = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { serviceWorker: { register } })

    registerPainfacePwa()

    expect(register).toHaveBeenCalledWith('./sw.js')
  })

  it('never throws when serviceWorker is unsupported, even in prod', () => {
    vi.stubEnv('PROD', true)
    vi.stubGlobal('navigator', {})

    expect(() => registerPainfacePwa()).not.toThrow()
  })
})
