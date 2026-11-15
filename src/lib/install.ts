/** True when the app already runs installed (home screen / standalone window). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches
}

/** iOS Safari never fires beforeinstallprompt; it needs the Share-sheet hint instead. */
export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  if (/iphone|ipad|ipod/i.test(navigator.userAgent ?? '')) return true
  // iPads in desktop mode pose as Macs; touch points give them away.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}
