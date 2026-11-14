import { useCallback, useEffect, useMemo, useState } from 'react'
import { allergyRollup, findDuplicates, neededCourses, ovenCount } from './lib/gaps.ts'
import { SAMPLE_SIGNUPS } from './lib/seed.ts'
import {
  APPS_SCRIPT_URL_STORAGE_KEY,
  DEFAULT_SUPABASE_ANON_KEY,
  DEFAULT_SUPABASE_URL,
  SUPABASE_KEY_STORAGE_KEY,
  SUPABASE_URL_STORAGE_KEY,
  createStore,
  forgetToken,
  getStoredSetting,
  ownsSignup,
  setStoredSetting,
  type SignupStore,
  type StoreMode,
} from './lib/storage.ts'
import { COURSES, DEFAULT_TARGETS, isCourse, type Course, type Signup, type Targets } from './lib/types.ts'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const MODE_KEY = 'potluck:store-mode'
const TARGETS_KEY = 'potluck:targets:v1'
const EVENT_KEY = 'potluck:event-name'

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
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)

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
      // Seed the four 2024 sample rows once per offline mode, and
      // persist them through the store so the first real signup does
      // not wipe them. The flag means clearing the samples stays cleared.
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
    // Seed the sample rows only for the offline modes; a central
    // backend starts empty so the Sheet / table is the source of truth.
    void refresh(s, mode === 'local' || mode === 'url')
  }, [mode, refresh])

  const gaps = useMemo(() => neededCourses(signups, targets), [signups, targets])
  const duplicates = useMemo(() => findDuplicates(signups), [signups])
  const allergies = useMemo(() => allergyRollup(signups), [signups])
  const ovens = ovenCount(signups)
  const hasSample = signups.some((s) => s.sample)

  function saveTargets(next: Targets) {
    setTargets(next)
    localStorage.setItem(TARGETS_KEY, JSON.stringify(next))
  }

  function saveEventName(name: string) {
    setEventName(name)
    localStorage.setItem(EVENT_KEY, name)
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
    setError('')
    try {
      if (editingId) {
        await store.update(editingId, {
          name,
          dish,
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
    <div className="layout">
      <aside>
        <h1>Potluck signup</h1>
        <label className="event-label">
          Event
          <input value={eventName} onChange={(e) => saveEventName(e.target.value)} aria-label="Event name" />
        </label>
        <p className="hint">
          {signups.length} {signups.length === 1 ? 'person' : 'people'} signed up · {ovens} {ovens === 1 ? 'dish needs' : 'dishes need'} the oven
        </p>

        <section className="panel">
          <h2>We could use more of</h2>
          {gaps.length === 0 ? (
            <p className="good">Every course has hit its target. Nice spread.</p>
          ) : (
            <ul className="gaps">
              {gaps.map((g) => (
                <li key={g.course}>
                  <strong>{g.course}</strong>: {g.count} of {g.target} — need {g.need} more
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary>Change the targets</summary>
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
          </details>
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

        <section className="panel">
          <h2>Where signups live</h2>
          <label>
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
            <button type="button" onClick={copyShareLink}>
              Copy share link
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
            {confirmClearSamples ? (
              <>
                Clear the four sample rows from the 2024 sheet and start fresh?{' '}
                <button type="button" className="link danger" onClick={() => void clearSample()}>
                  Confirm
                </button>{' '}
                <button type="button" className="link" onClick={() => setConfirmClearSamples(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                Showing four sample rows from the 2024 Friendsgiving sheet (Howard, Joe, Valerie, Gardner).{' '}
                <button type="button" className="link" onClick={() => setConfirmClearSamples(true)}>
                  Clear sample data
                </button>{' '}
                to start fresh.
              </>
            )}
          </p>
        )}
        {duplicates.length > 0 && (
          <p className="notice" role="alert">
            Heads up — duplicate dish{duplicates.length > 1 ? 'es' : ''}:{' '}
            {duplicates.map((d) => `${d.dish} (${d.names.join(' and ')})`).join('; ')}. Maybe coordinate so the menu is not doubled up.
          </p>
        )}

        <section>
          <h2>{editingId ? 'Edit your dish' : 'Sign up — what are you bringing?'}</h2>
          <form onSubmit={submit} className="form">
            <label>
              Your name
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label>
              Dish
              <input value={form.dish} onChange={(e) => setForm({ ...form, dish: e.target.value })} required />
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
  )
}
