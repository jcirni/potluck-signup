import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cuisineColor, loadCatalog, type Dish } from './lib/catalog.ts'
import { allergyRollup, computeGaps, findDuplicates, neededCourses, ovenCount, type CourseGap } from './lib/gaps.ts'
import { SAMPLE_SIGNUPS } from './lib/seed.ts'
import {
  APPS_SCRIPT_URL_STORAGE_KEY,
  DEFAULT_SUPABASE_ANON_KEY,
  DEFAULT_SUPABASE_URL,
  SUPABASE_KEY_STORAGE_KEY,
  SUPABASE_URL_STORAGE_KEY,
  createStore,
  eventAdminToken,
  forgetToken,
  getStoredSetting,
  ownsSignup,
  setStoredSetting,
  sha256Hex,
  type SignupStore,
  type StoreMode,
} from './lib/storage.ts'
import {
  ACCENTS,
  COURSES,
  DEFAULT_ACCENT,
  DEFAULT_TARGETS,
  isAccent,
  isCourse,
  type Accent,
  type Course,
  type PotluckEvent,
  type Signup,
  type Targets,
} from './lib/types.ts'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const MODE_KEY = 'potluck:store-mode'
const TARGETS_KEY = 'potluck:targets:v1'
const EVENT_KEY = 'potluck:event-name'
const ACCENT_KEY = 'potluck:accent'

function loadTargets(): Targets {
  try {
    const raw = JSON.parse(localStorage.getItem(TARGETS_KEY) ?? '{}') as Partial<Targets>
    return { ...DEFAULT_TARGETS, ...raw }
  } catch {
    return { ...DEFAULT_TARGETS }
  }
}

function emptyForm(): { name: string; dish: string; course: Course; needOven: boolean; allergies: string; servings: string } {
  return { name: '', dish: '', course: 'Mains', needOven: false, allergies: '', servings: '' }
}

/** '2026-11-26' -> 'Thursday, November 26, 2026'; unparseable input passes through. */
function formatEventDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

/** Progress line for one course in the gap view. */
function gapText(g: CourseGap): string {
  if (g.target === 0) return 'no target set'
  if (g.need === 0) return `${g.count} of ${g.target} — covered`
  if (g.need === 1) return `${g.count} of ${g.target} — one more would round it out`
  return `${g.count} of ${g.target} — need ${g.need} more`
}

export default function App() {
  const [mode, setMode] = useState<StoreMode>(() => {
    const saved = localStorage.getItem(MODE_KEY)
    return saved === 'url' || saved === 'apps-script' || saved === 'supabase' ? saved : 'local'
  })
  const [store, setStore] = useState<SignupStore>(() => createStore('local'))
  const [signups, setSignups] = useState<Signup[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [targets, setTargets] = useState<Targets>(loadTargets)
  const [eventName, setEventName] = useState(() => localStorage.getItem(EVENT_KEY) ?? 'Friendsgiving')
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [confirmClearSamples, setConfirmClearSamples] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [event, setEvent] = useState<PotluckEvent | null>(null)
  const [accent, setAccent] = useState<Accent>(() => {
    const saved = localStorage.getItem(ACCENT_KEY)
    return isAccent(saved) ? saved : DEFAULT_ACCENT
  })
  const [dishes, setDishes] = useState<Dish[]>([])
  const [dishFilter, setDishFilter] = useState('')
  const [pickedDishId, setPickedDishId] = useState<string | null>(null)
  const [formInView, setFormInView] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const formSectionRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      setInstallPrompt(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => setInstallPrompt(null)
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  // The management drawer closes on Escape and locks page scroll while open.
  useEffect(() => {
    if (!manageOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setManageOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [manageOpen])

  const installApp = useCallback(async () => {
    if (!installPrompt) return
    await installPrompt.prompt()
    await installPrompt.userChoice
    setInstallPrompt(null)
  }, [installPrompt])
  const [appsScriptUrl, setAppsScriptUrl] = useState(() => getStoredSetting(APPS_SCRIPT_URL_STORAGE_KEY))
  const [supabaseUrl, setSupabaseUrl] = useState(
    () => getStoredSetting(SUPABASE_URL_STORAGE_KEY) || DEFAULT_SUPABASE_URL,
  )
  const [supabaseKey, setSupabaseKey] = useState(
    () => getStoredSetting(SUPABASE_KEY_STORAGE_KEY) || DEFAULT_SUPABASE_ANON_KEY,
  )

  const refresh = useCallback(async (s: SignupStore, seedIfEmpty: boolean) => {
    setError('')
    try {
      const list = await s.list()
      // Seed the 2024 samples once per offline mode, through the store; the flag keeps a manual clear cleared.
      const seedKey = `potluck:seeded:${s.mode}`
      if (list.length === 0 && seedIfEmpty && !localStorage.getItem(seedKey)) {
        for (const sample of SAMPLE_SIGNUPS) await s.add(sample)
        localStorage.setItem(seedKey, '1')
        setSignups(SAMPLE_SIGNUPS)
      } else {
        setSignups(list)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load signups.')
      setSignups([])
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    const s = createStore(mode)
    setStore(s)
    setConfirmRemoveId(null)
    setConfirmClearSamples(false)
    localStorage.setItem(MODE_KEY, mode)
    setLoaded(false)
    // Seed samples only for offline modes; a central backend starts empty.
    void refresh(s, mode === 'local' || mode === 'url')
    // The event record carries the date, RSVP headcount, and accent; modes without one leave it null.
    setEvent(null)
    void s
      .getEvent(s.eventId)
      .then((ev) => {
        setEvent(ev)
        if (ev) setAccent(ev.accent)
      })
      .catch(() => setEvent(null))
  }, [mode, refresh])

  useEffect(() => {
    // The catalog powers the dish picker; without it the form still works as free text.
    void loadCatalog().then((c) => setDishes(c.dishes)).catch(() => setDishes([]))
  }, [])

  useEffect(() => {
    const el = formSectionRef.current
    if (!el) return
    const obs = new IntersectionObserver(([entry]) => setFormInView(entry.isIntersecting), { rootMargin: '-30% 0px -30% 0px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const gaps = useMemo(() => neededCourses(signups, targets), [signups, targets])
  const allGaps = useMemo(() => computeGaps(signups, targets), [signups, targets])
  const duplicates = useMemo(() => findDuplicates(signups), [signups])
  const allergies = useMemo(() => allergyRollup(signups), [signups])
  const ovens = ovenCount(signups)
  const hasSample = signups.some((s) => s.sample)
  const pickedDish = useMemo(() => dishes.find((d) => d.id === pickedDishId) ?? null, [dishes, pickedDishId])
  const filteredDishes = useMemo(() => {
    const q = dishFilter.trim().toLowerCase()
    const sorted = [...dishes].sort((a, b) => a.name.localeCompare(b.name))
    if (!q) return sorted
    return sorted.filter((d) => `${d.name} ${d.cuisine} ${d.course}`.toLowerCase().includes(q))
  }, [dishes, dishFilter])

  /** Sticky mobile button target: bring the signup form into view. */
  function scrollToForm() {
    formSectionRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  /** Claim-a-dish: preselect the course, then put the guest at the top of the form. */
  function claimCourse(course: Course) {
    setEditingId(null)
    setForm((f) => ({ ...f, course }))
    formSectionRef.current?.scrollIntoView({ behavior: 'smooth' })
    window.setTimeout(() => nameRef.current?.focus({ preventScroll: true }), 400)
  }

  /** Picking a catalog dish fills the form from it; the dish id rides along on submit. */
  function pickDish(d: Dish) {
    setPickedDishId(d.id)
    setForm((f) => ({
      ...f,
      dish: d.name,
      course: d.course,
      needOven: d.logistics.needsOven,
      servings: d.servings > 0 ? String(d.servings) : f.servings,
    }))
  }

  function saveTargets(next: Targets) {
    setTargets(next)
    localStorage.setItem(TARGETS_KEY, JSON.stringify(next))
  }

  function saveEventName(name: string) {
    setEventName(name)
    localStorage.setItem(EVENT_KEY, name)
  }

  // Accent editing is the host's: on Supabase that means holding the event's admin token.
  const canEditAccent = mode === 'supabase' ? eventAdminToken(store.eventId) !== undefined : true

  /** Re-skin at once, then persist: admin RPC on Supabase, the stored event record elsewhere. */
  async function pickAccent(next: Accent) {
    setAccent(next)
    localStorage.setItem(ACCENT_KEY, next)
    try {
      if (mode === 'supabase') {
        const token = eventAdminToken(store.eventId)
        if (token) await store.updateEvent(store.eventId, { accent: next }, await sha256Hex(token))
      } else if (event) {
        await store.updateEvent(store.eventId, { accent: next })
      }
      setEvent((prev) => (prev ? { ...prev, accent: next } : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the accent color.')
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const name = form.name.trim()
    const dish = form.dish.trim()
    if (!name || !dish) {
      setError('Name and dish are both required.')
      return
    }
    const servings = form.servings === '' ? 0 : Math.max(0, Number(form.servings) || 0)
    // The catalog id only rides along while the dish text still matches the picked dish.
    const dishId = pickedDish && pickedDish.name === dish ? pickedDish.id : undefined
    setError('')
    try {
      if (editingId) {
        await store.update(editingId, {
          name,
          dish,
          dishId,
          course: form.course,
          needOven: form.needOven,
          allergies: form.allergies.trim(),
          servings,
          sample: undefined,
        })
        setNotice('Updated.')
      } else {
        const signup: Signup = {
          id: crypto.randomUUID(),
          eventId: store.eventId,
          dishId,
          name,
          dish,
          course: form.course,
          needOven: form.needOven,
          allergies: form.allergies.trim(),
          servings,
          createdAt: new Date().toISOString(),
        }
        await store.add(signup)
        setNotice('You are signed up. Your edit link is saved in this browser, so you can change or remove your dish later.')
      }
      setForm(emptyForm())
      setPickedDishId(null)
      setEditingId(null)
      await refresh(store, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that signup.')
    }
  }

  async function removeSignup(s: Signup) {
    setConfirmRemoveId(null)
    try {
      await store.remove(s.id)
      forgetToken(s.id)
      await refresh(store, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove that signup.')
    }
  }

  async function clearSample() {
    setConfirmClearSamples(false)
    try {
      for (const s of signups.filter((x) => x.sample)) await store.remove(s.id)
      await refresh(store, false)
    } catch (err) {
      // Local / URL modes seed from memory, so clearing is local state.
      setSignups(signups.filter((x) => !x.sample))
      setError(err instanceof Error ? err.message : '')
    }
  }

  function copyShareLink() {
    const url = window.location.href
    void navigator.clipboard.writeText(url).then(
      () => setNotice(mode === 'url' ? 'Snapshot link copied. It carries this exact list.' : 'Link copied.'),
      () => setError('Could not copy the link. Copy it from the address bar instead.'),
    )
  }

  function startEdit(s: Signup) {
    setConfirmRemoveId(null)
    setPickedDishId(s.dishId ?? null)
    setForm({
      name: s.name,
      dish: s.dish,
      course: s.course,
      needOven: s.needOven,
      allergies: s.allergies,
      servings: s.servings > 0 ? String(s.servings) : '',
    })
    setEditingId(s.id)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="page" data-accent={accent}>
      <header className="hero">
        <button
          type="button"
          className="burger"
          onClick={() => setManageOpen(true)}
          aria-label="Manage event"
          aria-haspopup="dialog"
        >
          <span />
          <span />
          <span />
        </button>
        <p className="hero-eyebrow">Potluck signup</p>
        <h1 className="hero-name">{eventName}</h1>
        {event?.date && <p className="hero-date">{formatEventDate(event.date)}</p>}
        <div className="stats">
          <div className="stat">
            <span className="stat-num">{signups.length}</span>
            <span className="stat-label">{signups.length === 1 ? 'person' : 'people'} signed up</span>
          </div>
          <div className="stat">
            <span className="stat-num">{signups.length}</span>
            <span className="stat-label">dishes on the menu</span>
          </div>
          <div className="stat">
            <span className="stat-num">{ovens}</span>
            <span className="stat-label">{ovens === 1 ? 'dish needs' : 'dishes need'} the oven</span>
          </div>
          {event !== null && event.headcount > 0 && (
            <div className="stat">
              <span className="stat-num">{event.headcount}</span>
              <span className="stat-label">RSVP headcount</span>
            </div>
          )}
        </div>
        <div className="hero-actions">
          <button type="button" className="link" onClick={copyShareLink}>
            Copy share link
          </button>
        </div>
      </header>

      <div className="layout">
      <aside>
        <section className="panel">
          <h2>We could use more of</h2>
          {gaps.length === 0 && <p className="good">Every course has hit its target. Nice spread.</p>}
          <ul className="gap-list">
            {allGaps.map((g) => (
              <li key={g.course} className="gap-row">
                <div className="gap-head">
                  <strong>{g.course}</strong>
                  <span className="hint">{gapText(g)}</span>
                </div>
                <div className="gapbar" aria-hidden="true">
                  <div
                    className="gapbar-fill"
                    style={{ width: `${g.target > 0 ? Math.min(100, (g.count / g.target) * 100) : 0}%` }}
                  />
                </div>
                {g.need > 0 && (
                  <button type="button" className="link" onClick={() => claimCourse(g.course)}>
                    I&rsquo;ll bring this
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {allergies.length > 0 && (
          <section className="panel">
            <h2>Allergies &amp; dietary notes</h2>
            <ul>
              {allergies.map((a) => (
                <li key={`${a.name}-${a.dish}`}>
                  <strong>{a.name}</strong> ({a.dish}): {a.note}
                </li>
              ))}
            </ul>
          </section>
        )}

      </aside>

      <main>
        {error && <p className="notice error" role="alert">{error}</p>}
        {notice && (
          <p className="notice">
            {notice} <button type="button" className="link" onClick={() => setNotice('')}>Dismiss</button>
          </p>
        )}
        {hasSample && (
          <p className="notice">
            Showing four sample rows from the 2024 Friendsgiving sheet (Howard, Joe, Valerie, Gardner).
          </p>
        )}
        {duplicates.length > 0 && (
          <p className="notice" role="alert">
            Heads up — duplicate dish{duplicates.length > 1 ? 'es' : ''}:{' '}
            {duplicates.map((d) => `${d.dish} (${d.names.join(' and ')})`).join('; ')}. Maybe coordinate so the menu is not doubled up.
          </p>
        )}

        <section ref={formSectionRef} className="form-section">
          <h2>{editingId ? 'Edit your dish' : 'Sign up — what are you bringing?'}</h2>
          {dishes.length > 0 && (
            <div className="picker">
              <label className="picker-search">
                Pick from the catalog
                <input
                  type="search"
                  placeholder="Search dishes or cuisines…"
                  value={dishFilter}
                  onChange={(e) => setDishFilter(e.target.value)}
                />
              </label>
              {pickedDish && (
                <p className="hint">
                  Picked: <strong>{pickedDish.name}</strong>{' '}
                  <button type="button" className="link" onClick={() => setPickedDishId(null)}>
                    Clear
                  </button>
                </p>
              )}
              {filteredDishes.length === 0 ? (
                <p className="hint">No dishes match. You can still type your own dish below.</p>
              ) : (
                <ul className="picker-list">
                  {filteredDishes.slice(0, 60).map((d) => (
                    <li key={d.id}>
                      <button
                        type="button"
                        className={`picker-row${d.id === pickedDishId ? ' picked' : ''}`}
                        onClick={() => pickDish(d)}
                      >
                        <span className="picker-name">{d.name}</span>
                        <span className="chip" style={{ background: cuisineColor(d.cuisine) }}>{d.cuisine}</span>
                        <span className="badge">{d.macros.calories} kcal</span>
                        <span className="badge">{d.macros.proteinG}g protein</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {filteredDishes.length > 60 && (
                <p className="hint">Showing 60 of {filteredDishes.length}. Keep typing to narrow it down.</p>
              )}
            </div>
          )}
          <form onSubmit={submit} className="form">
            <label>
              Your name
              <input ref={nameRef} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label>
              Dish
              <input
                value={form.dish}
                onChange={(e) => {
                  setForm({ ...form, dish: e.target.value })
                  // Typing a different dish by hand un-picks the catalog dish.
                  if (pickedDish && e.target.value !== pickedDish.name) setPickedDishId(null)
                }}
                required
              />
            </label>
            <label>
              Course
              <select
                value={form.course}
                onChange={(e) => setForm({ ...form, course: isCourse(e.target.value) ? e.target.value : 'Mains' })}
              >
                {COURSES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.needOven}
                onChange={(e) => setForm({ ...form, needOven: e.target.checked })}
              />
              Needs the oven
            </label>
            <label>
              Servings (optional)
              <input
                type="number"
                min={0}
                value={form.servings}
                onChange={(e) => setForm({ ...form, servings: e.target.value })}
              />
            </label>
            <label>
              Food allergies / dietary notes
              <input
                value={form.allergies}
                onChange={(e) => setForm({ ...form, allergies: e.target.value })}
                placeholder="e.g. nut allergy, vegetarian"
              />
            </label>
            <div className="row">
              <button type="submit" className="primary">{editingId ? 'Save changes' : 'Sign up'}</button>
              {editingId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(null)
                    setPickedDishId(null)
                    setForm(emptyForm())
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </section>

        <section>
          <h2>The menu so far</h2>
          {!loaded ? (
            <p className="hint">Loading…</p>
          ) : signups.length === 0 ? (
            <p className="hint">Nobody has signed up yet. Be the first.</p>
          ) : (
            COURSES.map((course) => {
              const rows = signups.filter((s) => s.course === course)
              if (rows.length === 0) return null
              return (
                <div key={course} className="course-group">
                  <h3>
                    {course} ({rows.length})
                  </h3>
                  <ul className="menu">
                    {rows.map((s) => {
                      const canEdit = s.sample === true || ownsSignup(s.id)
                      return (
                        <li key={s.id}>
                          <strong>{s.dish}</strong> — {s.name}
                          {s.servings > 0 && <span className="hint"> · serves {s.servings}</span>}
                          {s.needOven && <span className="tag">oven</span>}
                          {s.allergies && <span className="hint"> · {s.allergies}</span>}
                          {s.sample === true && <span className="tag sample">sample</span>}
                          {canEdit && (
                            <span className="actions">
                              {confirmRemoveId === s.id ? (
                                <>
                                  <span>Remove this signup?</span>
                                  <button type="button" className="link danger" onClick={() => void removeSignup(s)}>
                                    Confirm
                                  </button>
                                  <button type="button" className="link" onClick={() => setConfirmRemoveId(null)}>
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button type="button" className="link" onClick={() => startEdit(s)}>
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="link danger"
                                    onClick={() => setConfirmRemoveId(s.id)}
                                  >
                                    Remove
                                  </button>
                                </>
                              )}
                            </span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })
          )}
        </section>
      </main>
      </div>

      <footer className="page-footer">
        <button type="button" className="link" onClick={() => setManageOpen(true)}>
          Manage event
        </button>
      </footer>

      {manageOpen && (
        <>
          <div className="drawer-backdrop" onClick={() => setManageOpen(false)} />
          <div className="drawer" role="dialog" aria-modal="true" aria-label="Manage event">
            <div className="drawer-head">
              <h2>Manage event</h2>
              <button type="button" className="drawer-close" onClick={() => setManageOpen(false)} aria-label="Close">
                ×
              </button>
            </div>

            <section className="drawer-section">
              <label className="event-label">
                Event name
                <input value={eventName} onChange={(e) => saveEventName(e.target.value)} aria-label="Event name" />
              </label>
            </section>

            {canEditAccent && (
              <section className="drawer-section">
                <h3>Accent color</h3>
                <div className="swatches" role="group" aria-label="Event accent color">
                  {ACCENTS.map((a) => (
                    <button
                      key={a}
                      type="button"
                      className={`swatch${accent === a ? ' selected' : ''}`}
                      data-swatch={a}
                      onClick={() => void pickAccent(a)}
                      aria-label={`${a} accent`}
                      aria-pressed={accent === a}
                      title={a}
                    />
                  ))}
                </div>
              </section>
            )}

            <section className="drawer-section">
              <h3>Course targets</h3>
              <div className="targets">
                {COURSES.map((course) => (
                  <label key={course}>
                    {course}
                    <input
                      type="number"
                      min={0}
                      value={targets[course]}
                      onChange={(e) =>
                        saveTargets({ ...targets, [course]: Math.max(0, Number(e.target.value) || 0) })
                      }
                    />
                  </label>
                ))}
              </div>
            </section>

            <section className="drawer-section">
              <h3>Where signups live</h3>
              <label className="event-label">
                Storage
                <select value={mode} onChange={(e) => setMode(e.target.value as StoreMode)}>
                  <option value="local">This browser only (demo)</option>
                  <option value="url">Share link — snapshot in the URL</option>
                  <option value="apps-script">Google Sheet (Apps Script)</option>
                  <option value="supabase">Supabase (Postgres)</option>
                </select>
              </label>
              <p className="hint">{store.note}</p>
              <div className="row">
                <button type="button" onClick={() => void refresh(store, false)}>
                  Refresh
                </button>
                <button type="button" onClick={() => setShowSettings((v) => !v)}>
                  {showSettings ? 'Hide settings' : 'Settings'}
                </button>
                {installPrompt && (
                  <button type="button" onClick={() => void installApp()}>
                    Install app
                  </button>
                )}
              </div>
              {showSettings && (
                <div className="settings">
                  <label>
                    Apps Script web app URL
                    <input
                      type="url"
                      placeholder="https://script.google.com/macros/s/.../exec"
                      value={appsScriptUrl}
                      onChange={(e) => {
                        setAppsScriptUrl(e.target.value)
                        setStoredSetting(APPS_SCRIPT_URL_STORAGE_KEY, e.target.value)
                      }}
                    />
                  </label>
                  <label>
                    Supabase project URL
                    <input
                      type="url"
                      placeholder="https://xyzcompany.supabase.co"
                      value={supabaseUrl}
                      onChange={(e) => {
                        setSupabaseUrl(e.target.value)
                        setStoredSetting(SUPABASE_URL_STORAGE_KEY, e.target.value)
                      }}
                    />
                  </label>
                  <label>
                    Supabase anon key
                    <input
                      type="password"
                      value={supabaseKey}
                      onChange={(e) => {
                        setSupabaseKey(e.target.value)
                        setStoredSetting(SUPABASE_KEY_STORAGE_KEY, e.target.value)
                      }}
                    />
                  </label>
                  <p className="hint">
                    Keys live in this browser only. The backend code is in <code>backend/Code.gs</code> (Apps Script) and{' '}
                    <code>backend/supabase.sql</code> (Supabase).
                  </p>
                </div>
              )}
            </section>

            <section className="drawer-section">
              <h3>Share link</h3>
              <p className="share-link">
                <code>{window.location.href}</code>
              </p>
              <div className="row">
                <button type="button" onClick={copyShareLink}>
                  Copy share link
                </button>
              </div>
            </section>

            {hasSample && (
              <section className="drawer-section">
                <h3>Sample data</h3>
                {confirmClearSamples ? (
                  <p className="hint">
                    Clear the four sample rows from the 2024 sheet and start fresh?{' '}
                    <button type="button" className="link danger" onClick={() => void clearSample()}>
                      Confirm
                    </button>{' '}
                    <button type="button" className="link" onClick={() => setConfirmClearSamples(false)}>
                      Cancel
                    </button>
                  </p>
                ) : (
                  <p className="hint">
                    This event still shows the four sample rows.{' '}
                    <button type="button" className="link" onClick={() => setConfirmClearSamples(true)}>
                      Clear sample data
                    </button>
                  </p>
                )}
              </section>
            )}
          </div>
        </>
      )}

      {!formInView && !manageOpen && (
        <button type="button" className="sticky-signup" onClick={scrollToForm}>
          {editingId ? 'Back to the form' : 'Sign up'}
        </button>
      )}
    </div>
  )
}
