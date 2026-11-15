import { afterEach, describe, expect, it, vi } from 'vitest'
import { isIosDevice, isStandalone } from './install.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isIosDevice', () => {
  it('detects iPhone and iPad user agents', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 })
    expect(isIosDevice()).toBe(true)
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', platform: 'iPad', maxTouchPoints: 5 })
    expect(isIosDevice()).toBe(true)
  })

  it('detects an iPad posing as a Mac by its touch points', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 })
    expect(isIosDevice()).toBe(true)
  })

  it('leaves Android and desktop browsers alone', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)', platform: 'Linux armv8l', maxTouchPoints: 5 })
    expect(isIosDevice()).toBe(false)
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })
    expect(isIosDevice()).toBe(false)
  })
})

describe('isStandalone', () => {
  it('is false in a plain server-side context', () => {
    expect(isStandalone()).toBe(false)
  })

  it('honors the iOS navigator.standalone flag', () => {
    vi.stubGlobal('window', { navigator: { standalone: true }, matchMedia: () => ({ matches: false }) })
    expect(isStandalone()).toBe(true)
  })

  it('honors the standalone display mode', () => {
    vi.stubGlobal('window', { navigator: {}, matchMedia: (q: string) => ({ matches: q.includes('standalone') }) })
    expect(isStandalone()).toBe(true)
  })
})
