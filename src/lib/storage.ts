import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Course, DietaryNeeds, PotluckEvent, Signup, Targets } from './types.ts'
import { COURSES, DEFAULT_TARGETS, EMPTY_DIETARY_NEEDS, isCourse } from './types.ts'

export type StoreMode = 'local' | 'url' | 'apps-script' | 'supabase'

/**
 * One store interface for every backend. The frontend never talks to
 * a backend directly, so switching from the demo to Supabase is a
 * mode change in Settings, not a rebuild.
 *
 * Userless model: no accounts anywhere. Identity is possession of a
 * token. A guest's edit token lives only in their browser; only its
 * SHA-256 hash is stored with the signup. An event's admin token
 * lives only in the admin link; only its hash is stored with the
 * event. The central backends enforce those hashes (Supabase via
 * database functions, see backend/supabase.sql); the offline modes
 * trust the browser, which is fine for a demo.
 */
export interface SignupStore {
  mode: StoreMode
  label: string
  /** Short human-readable note about what this mode does and does not do. */
  note: string
  /** The event this store instance is bound to. The single-event UI
   * (App.tsx) works against this event through list/add/update/remove
   * below; the *Event / *Signup methods take explicit ids for
   * event-aware callers. */
  readonly eventId: string
  createEvent(event: PotluckEvent, adminTokenHash: string): Promise<void>
  getEvent(id: string): Promise<PotluckEvent | null>
  /** Offline modes list events stored in this browser. Supabase returns [] by design: there is no public event directory. */
  listEvents(): Promise<PotluckEvent[]>
  updateEvent(id: string, patch: Partial<PotluckEvent>, adminTokenHash?: string): Promise<void>
  listSignups(eventId: string): Promise<Signup[]>
  addSignup(signup: Signup): Promise<void>
  updateSignup(id: string, patch: Partial<Signup>, editTokenHash?: string): Promise<void>
  removeSignup(id: string, opts?: { eventId: string; editTokenHash?: string; adminTokenHash?: string }): Promise<void>
  /** Signups for the bound event (eventId above). */
  list(): Promise<Signup[]>
  /** Add a signup to the bound event. Mints this browser's edit token
   * for the signup and stores only its hash, if the signup has none. */
  add(signup: Signup): Promise<void>
  /** Edit a signup, using the edit token this browser holds for it. */
  update(id: string, patch: Partial<Signup>): Promise<void>
  /** Remove a signup, using the edit token this browser holds for it. */
  remove(id: string): Promise<void>
}

const LOCAL_EVENTS_KEY = 'potluck:events:v1'
const LOCAL_SIGNUPS_KEY = 'potluck:signups:v1'
const TOKEN_KEY = 'potluck:tokens:v1'
const APPS_SCRIPT_URL_KEY = 'potluck:apps-script-url'
const APPS_SCRIPT_EVENT_KEY = 'potluck:apps-script-event'
const SUPABASE_URL_KEY = 'potluck:supabase-url'
const SUPABASE_KEY_KEY = 'potluck:supabase-anon-key'

/**
 * The potluck-signup Supabase project, used when Settings has no
 * override. Both values are public by design: the anon key is safe
 * to ship in client code, and row-level security (plus the token
 * checking database functions) is what protects writes.
 */
export const DEFAULT_SUPABASE_URL = 'https://qpzohrhtyhwcvukzjoep.supabase.co'
export const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwem9ocmh0eWh3Y3Z1a3pqb2VwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2ODUxNDQsImV4cCI6MjExMDI2MTE0NH0.7XhSSNR-KoKrFLQDsZYSNQMOCndbqMkmiRUffau8BiU'

/** The event the single-event UI is bound to (the demo event). */
export const DEFAULT_EVENT_ID = 'friendsgiving'

export function getStoredSetting(key: string): string {
  return localStorage.getItem(key) ?? ''
}

export function setStoredSetting(key: string, value: string): void {
  if (value) localStorage.setItem(key, value)
  else localStorage.removeItem(key)
}

export const APPS_SCRIPT_URL_STORAGE_KEY = APPS_SCRIPT_URL_KEY
export const SUPABASE_URL_STORAGE_KEY = SUPABASE_URL_KEY
export const SUPABASE_KEY_STORAGE_KEY = SUPABASE_KEY_KEY

/** SHA-256 hex of a token. Only the hash ever leaves the browser. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Edit tokens: one per signup id, kept only in this browser.
 * Minting is idempotent: a token that already exists for the id is
 * returned, never replaced. The backend stored the hash of the first
 * token at insert time, so swapping in a fresh token afterwards
 * would silently orphan the signup (its stored hash would no longer
 * match anything this browser holds, and edit/remove would fail the
 * token check). That exact overwrite once shipped as a bug: App
 * minted a second token right after add() and clobbered the first.
 */
export function mintToken(id: string): string {
  const tokens = readTokens()
  const existing = tokens[id]
  if (existing) return existing
  const token = crypto.randomUUID()
  tokens[id] = token
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens))
  return token
}

export function ownsSignup(id: string): boolean {
  return id in readTokens()
}

export function forgetToken(id: string): void {
  const tokens = readTokens()
  delete tokens[id]
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens))
}

function readTokens(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

/** Hash of the edit token this browser holds for a signup, if any. */
async function storedEditTokenHash(id: string): Promise<string | undefined> {
  const token = readTokens()[id]
  return token ? sha256Hex(token) : undefined
}

/**
 * Prepare a signup for add(): make sure this browser holds an edit
 * token for it and the signup carries that token's hash, so the
 * signup stays editable (and removable) from this browser later.
 * Signups that already carry a hash are left as they are.
 */
async function withEditToken(signup: Signup): Promise<Signup> {
  if (signup.editTokenHash) return signup
  const token = readTokens()[signup.id] ?? mintToken(signup.id)
  return { ...signup, editTokenHash: await sha256Hex(token) }
}

function cleanTargets(raw: unknown): Targets | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const out = {} as Targets
  for (const c of COURSES) {
    if (typeof r[c] !== 'number') return null
    out[c] = r[c]
  }
  return out
}

/** Lenient on purpose: older stored events predate dietary needs, so
 * missing or partial values fall back to zero counts, not rejection. */
function cleanDietaryNeeds(raw: unknown): DietaryNeeds {
  const out: DietaryNeeds = { ...EMPTY_DIETARY_NEEDS }
  if (typeof raw !== 'object' || raw === null) return out
  const r = raw as Record<string, unknown>
  for (const k of Object.keys(out) as (keyof DietaryNeeds)[]) {
    if (typeof r[k] === 'number') out[k] = r[k] as number
  }
  return out
}

export function cleanEvent(raw: unknown): PotluckEvent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const targets = cleanTargets(r.targets)
  // Length limit mirrors the events table check in backend/supabase.sql.
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || r.name.length < 1 || r.name.length > 120 || !targets) return null
  return {
    id: r.id,
    name: r.name,
    date: typeof r.date === 'string' ? r.date : '',
    headcount: typeof r.headcount === 'number' ? r.headcount : 0,
    targets,
    dietaryNeeds: cleanDietaryNeeds(r.dietaryNeeds),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
  }
}

export function cleanSignup(raw: unknown): Signup | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.dish !== 'string') return null
  if (typeof r.course !== 'string' || !isCourse(r.course)) return null
  if (typeof r.eventId !== 'string') return null
  // Length and range limits mirror the signups table checks in
  // backend/supabase.sql, so bad rows are rejected the same way here.
  if (r.name.length < 1 || r.name.length > 80) return null
  if (r.dish.length < 1 || r.dish.length > 120) return null
  if (typeof r.allergies === 'string' && r.allergies.length > 200) return null
  if (typeof r.dishId === 'string' && r.dishId.length > 80) return null
  if (typeof r.scale === 'number' && !(r.scale > 0 && r.scale <= 10)) return null
  return {
    id: r.id,
    eventId: r.eventId,
    dishId: typeof r.dishId === 'string' ? r.dishId : undefined,
    scale: typeof r.scale === 'number' ? r.scale : undefined,
    name: r.name,
    dish: r.dish,
    course: r.course as Course,
    needOven: r.needOven === true,
    allergies: typeof r.allergies === 'string' ? r.allergies : '',
    servings: typeof r.servings === 'number' ? r.servings : 0,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    editTokenHash: typeof r.editTokenHash === 'string' ? r.editTokenHash : undefined,
    sample: r.sample === true ? true : undefined,
  }
}

export function cleanEventList(raw: unknown): PotluckEvent[] {
  if (!Array.isArray(raw)) return []
  return raw.map(cleanEvent).filter((e): e is PotluckEvent => e !== null)
}

export function cleanSignupList(raw: unknown): Signup[] {
  if (!Array.isArray(raw)) return []
  return raw.map(cleanSignup).filter((s): s is Signup => s !== null)
}

/** Demo / single-browser mode. Events and signups live in this browser only. */
export class LocalStore implements SignupStore {
  mode: StoreMode = 'local'
  label = 'This browser only'
  note = 'Events and signups are stored in this browser (localStorage). Good for trying the app; other guests will not see them.'
  readonly eventId = DEFAULT_EVENT_ID

  private readEvents(): PotluckEvent[] {
    return cleanEventList(JSON.parse(localStorage.getItem(LOCAL_EVENTS_KEY) ?? '[]'))
  }

  private writeEvents(events: PotluckEvent[]): void {
    localStorage.setItem(LOCAL_EVENTS_KEY, JSON.stringify(events))
  }

  private readSignups(): Signup[] {
    return cleanSignupList(JSON.parse(localStorage.getItem(LOCAL_SIGNUPS_KEY) ?? '[]'))
  }

  private writeSignups(signups: Signup[]): void {
    localStorage.setItem(LOCAL_SIGNUPS_KEY, JSON.stringify(signups))
  }

  async createEvent(event: PotluckEvent): Promise<void> {
    this.writeEvents([...this.readEvents(), event])
  }

  async getEvent(id: string): Promise<PotluckEvent | null> {
    return this.readEvents().find((e) => e.id === id) ?? null
  }

  async listEvents(): Promise<PotluckEvent[]> {
    return this.readEvents()
  }

  async updateEvent(id: string, patch: Partial<PotluckEvent>): Promise<void> {
    this.writeEvents(this.readEvents().map((e) => (e.id === id ? { ...e, ...patch } : e)))
  }

  async listSignups(eventId: string): Promise<Signup[]> {
    return this.readSignups().filter((s) => s.eventId === eventId)
  }

  async addSignup(signup: Signup): Promise<void> {
    this.writeSignups([...this.readSignups(), signup])
  }

  async updateSignup(id: string, patch: Partial<Signup>): Promise<void> {
    this.writeSignups(this.readSignups().map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  async removeSignup(id: string): Promise<void> {
    this.writeSignups(this.readSignups().filter((s) => s.id !== id))
  }

  async list(): Promise<Signup[]> {
    return this.listSignups(this.eventId)
  }

  async add(signup: Signup): Promise<void> {
    await this.addSignup({ ...(await withEditToken(signup)), eventId: signup.eventId || this.eventId })
  }

  async update(id: string, patch: Partial<Signup>): Promise<void> {
    await this.updateSignup(id, patch)
  }

  async remove(id: string): Promise<void> {
    await this.removeSignup(id)
  }
}

interface UrlSnapshot {
  event: PotluckEvent | null
  signups: Signup[]
}

/**
 * Snapshot mode. The current event and its list are Base64URL-encoded
 * JSON in the URL hash (`#s=...`), so the link itself carries the
 * latest state. It never sees a server, which is exactly why it
 * forks: two people opening the same link at once each make a
 * different new link. Use it for sharing a snapshot / export, not as
 * the live signup system. Only the most recent event is in the link.
 */
export class UrlSnapshotStore implements SignupStore {
  mode: StoreMode = 'url'
  label = 'Share link (snapshot)'
  note = 'The event and its list live in the link itself (#s=...). Share a snapshot, but two people signing up from the same link will fork into different lists, and only the latest event fits in a link.'

  get eventId(): string {
    return this.readSnapshot().event?.id ?? DEFAULT_EVENT_ID
  }

  private readSnapshot(): UrlSnapshot {
    const match = /#s=([A-Za-z0-9_-]+)/.exec(window.location.hash)
    if (!match) return { event: null, signups: [] }
    try {
      const json = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'))
      const raw = JSON.parse(decodeURIComponent(escape(json))) as { event?: unknown; signups?: unknown }
      return { event: cleanEvent(raw.event), signups: cleanSignupList(raw.signups) }
    } catch {
      return { event: null, signups: [] }
    }
  }

  private writeSnapshot(snapshot: UrlSnapshot): void {
    const json = unescape(encodeURIComponent(JSON.stringify(snapshot)))
    const encoded = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const url = new URL(window.location.href)
    url.hash = `s=${encoded}`
    window.history.replaceState(null, '', url)
  }

  async createEvent(event: PotluckEvent): Promise<void> {
    this.writeSnapshot({ event, signups: [] })
  }

  async getEvent(id: string): Promise<PotluckEvent | null> {
    const { event } = this.readSnapshot()
    return event && event.id === id ? event : null
  }

  async listEvents(): Promise<PotluckEvent[]> {
    const { event } = this.readSnapshot()
    return event ? [event] : []
  }

  async updateEvent(id: string, patch: Partial<PotluckEvent>): Promise<void> {
    const snap = this.readSnapshot()
    if (snap.event && snap.event.id === id) {
      this.writeSnapshot({ ...snap, event: { ...snap.event, ...patch } })
    }
  }

  async listSignups(eventId: string): Promise<Signup[]> {
    return this.readSnapshot().signups.filter((s) => s.eventId === eventId)
  }

  async addSignup(signup: Signup): Promise<void> {
    const snap = this.readSnapshot()
    this.writeSnapshot({ ...snap, signups: [...snap.signups, signup] })
  }

  async updateSignup(id: string, patch: Partial<Signup>): Promise<void> {
    const snap = this.readSnapshot()
    this.writeSnapshot({ ...snap, signups: snap.signups.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  }

  async removeSignup(id: string): Promise<void> {
    const snap = this.readSnapshot()
    this.writeSnapshot({ ...snap, signups: snap.signups.filter((s) => s.id !== id) })
  }

  async list(): Promise<Signup[]> {
    return this.listSignups(this.eventId)
  }

  async add(signup: Signup): Promise<void> {
    await this.addSignup({ ...(await withEditToken(signup)), eventId: signup.eventId || this.eventId })
  }

  async update(id: string, patch: Partial<Signup>): Promise<void> {
    await this.updateSignup(id, patch)
  }

  async remove(id: string): Promise<void> {
    await this.removeSignup(id)
  }
}

interface AppsScriptResponse {
  signups?: unknown
  ok?: boolean
  error?: string
}

/**
 * Single-event fallback: a Google Apps Script web app backed by the
 * Sheet Joseph already uses. The Sheet stays the admin view / backup.
 * It holds exactly one event, so event details live in this browser
 * and the Sheet holds only the signups. Deploy backend/Code.gs as a
 * web app (Execute as: Me, access: Anyone) and paste its URL in
 * Settings. For the public, anyone-can-create-an-event version,
 * Supabase is the backend, not this one.
 */
export class AppsScriptStore implements SignupStore {
  mode: StoreMode = 'apps-script'
  label = 'Google Sheet (Apps Script, one event)'
  note = 'One central list in the Sheet, for one event only. Everyone who opens the link sees the same signups. It cannot host other peoples events; use Supabase for that.'
  readonly eventId = DEFAULT_EVENT_ID

  private endpoint(): string {
    return getStoredSetting(APPS_SCRIPT_URL_KEY)
  }

  private readEvent(): PotluckEvent | null {
    try {
      return cleanEvent(JSON.parse(localStorage.getItem(APPS_SCRIPT_EVENT_KEY) ?? 'null'))
    } catch {
      return null
    }
  }

  private async call(body: Record<string, unknown>): Promise<AppsScriptResponse> {
    const endpoint = this.endpoint()
    if (!endpoint) throw new Error('Apps Script URL is not set. Open Settings and paste the web app URL.')
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Apps Script request failed (${res.status}).`)
    const data = (await res.json()) as AppsScriptResponse
    if (data.error) throw new Error(data.error)
    return data
  }

  async createEvent(event: PotluckEvent): Promise<void> {
    localStorage.setItem(APPS_SCRIPT_EVENT_KEY, JSON.stringify(event))
  }

  async getEvent(id: string): Promise<PotluckEvent | null> {
    const event = this.readEvent()
    return event && event.id === id ? event : null
  }

  async listEvents(): Promise<PotluckEvent[]> {
    const event = this.readEvent()
    return event ? [event] : []
  }

  async updateEvent(id: string, patch: Partial<PotluckEvent>): Promise<void> {
    const event = this.readEvent()
    if (event && event.id === id) {
      localStorage.setItem(APPS_SCRIPT_EVENT_KEY, JSON.stringify({ ...event, ...patch }))
    }
  }

  async listSignups(_eventId: string): Promise<Signup[]> {
    const endpoint = this.endpoint()
    if (!endpoint) throw new Error('Apps Script URL is not set. Open Settings and paste the web app URL.')
    const res = await fetch(`${endpoint}?action=list`)
    if (!res.ok) throw new Error(`Apps Script request failed (${res.status}).`)
    const data = (await res.json()) as AppsScriptResponse
    // The Sheet holds one event only and its rows carry no eventId;
    // stamp the bound event on the raw rows so they pass validation.
    const raw = Array.isArray(data.signups) ? data.signups : []
    return cleanSignupList(
      raw.map((row) =>
        typeof row === 'object' && row !== null
          ? { ...(row as Record<string, unknown>), eventId: (row as Record<string, unknown>).eventId ?? this.eventId }
          : row,
      ),
    )
  }

  async addSignup(signup: Signup): Promise<void> {
    await this.call({ action: 'add', signup })
  }

  async updateSignup(id: string, patch: Partial<Signup>): Promise<void> {
    await this.call({ action: 'update', id, patch })
  }

  async removeSignup(id: string): Promise<void> {
    await this.call({ action: 'remove', id })
  }

  async list(): Promise<Signup[]> {
    return this.listSignups(this.eventId)
  }

  async add(signup: Signup): Promise<void> {
    await this.addSignup({ ...(await withEditToken(signup)), eventId: signup.eventId || this.eventId })
  }

  async update(id: string, patch: Partial<Signup>): Promise<void> {
    await this.updateSignup(id, patch)
  }

  async remove(id: string): Promise<void> {
    await this.removeSignup(id)
  }
}

/**
 * The public backend: Supabase (free Postgres). Anyone can create
 * their own event, no accounts. The anon key is publishable by
 * design; row-level security is what protects writes (see
 * backend/supabase.sql): anonymous visitors can read events and
 * signups and insert a signup, and edits/deletes go through
 * database functions that check the token hash.
 */
export class SupabaseStore implements SignupStore {
  mode: StoreMode = 'supabase'
  label = 'Supabase (Postgres, public)'
  note = 'One central database for every event anyone creates. Works out of the box with the potluck-signup project; Settings can point it at a different project. The tables come from backend/supabase.sql.'
  readonly eventId: string

  private cachedClient: SupabaseClient | null = null
  private cachedConfig = ''

  constructor() {
    // The bound event comes from the share link (?event=<id>) when
    // present, and falls back to the demo event.
    const fromUrl = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('event') : null
    this.eventId = fromUrl || DEFAULT_EVENT_ID
  }

  private config(): { url: string; key: string } {
    const url = (getStoredSetting(SUPABASE_URL_KEY) || DEFAULT_SUPABASE_URL).replace(/\/$/, '')
    const key = getStoredSetting(SUPABASE_KEY_KEY) || DEFAULT_SUPABASE_ANON_KEY
    return { url, key }
  }

  private client(): SupabaseClient {
    const { url, key } = this.config()
    const cacheKey = `${url}|${key}`
    if (!this.cachedClient || this.cachedConfig !== cacheKey) {
      this.cachedClient = createClient(url, key)
      this.cachedConfig = cacheKey
    }
    return this.cachedClient
  }

  private eventRow(event: PotluckEvent, adminTokenHash: string): Record<string, unknown> {
    return {
      id: event.id,
      name: event.name,
      date: event.date || null,
      headcount: event.headcount,
      targets: event.targets,
      dietary_needs: event.dietaryNeeds,
      admin_token_hash: adminTokenHash,
    }
  }

  private signupRow(signup: Signup): Record<string, unknown> {
    return {
      id: signup.id,
      event_id: signup.eventId,
      dish_id: signup.dishId ?? null,
      scale: signup.scale ?? null,
      name: signup.name,
      dish: signup.dish,
      course: signup.course,
      need_oven: signup.needOven,
      allergies: signup.allergies,
      servings: signup.servings,
      edit_token_hash: signup.editTokenHash ?? null,
    }
  }

  /** Translate a database row (snake_case) into the shape cleanEvent expects. */
  private eventFromRow(r: Record<string, unknown>): PotluckEvent | null {
    return cleanEvent({
      id: r.id,
      name: r.name,
      date: r.date,
      headcount: r.headcount,
      targets: r.targets,
      dietaryNeeds: r.dietary_needs,
      createdAt: r.created_at,
    })
  }

  /** Translate a database row (snake_case) into the shape cleanSignup expects. */
  private signupFromRow(r: Record<string, unknown>): unknown {
    return {
      id: r.id,
      eventId: r.event_id,
      dishId: r.dish_id ?? undefined,
      scale: typeof r.scale === 'number' ? r.scale : undefined,
      name: r.name,
      dish: r.dish,
      course: r.course,
      needOven: r.need_oven,
      allergies: r.allergies,
      servings: r.servings,
      createdAt: r.created_at,
      editTokenHash: r.edit_token_hash ?? undefined,
    }
  }

  async createEvent(event: PotluckEvent, adminTokenHash: string): Promise<void> {
    const { error } = await this.client().from('events').insert(this.eventRow(event, adminTokenHash))
    if (error) throw new Error(`Supabase request failed: ${error.message}`)
  }

  async getEvent(id: string): Promise<PotluckEvent | null> {
    const { data, error } = await this.client()
      .from('events')
      .select('id,name,date,headcount,targets,dietary_needs,created_at')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(`Supabase request failed: ${error.message}`)
    return data ? this.eventFromRow(data as Record<string, unknown>) : null
  }

  async listEvents(): Promise<PotluckEvent[]> {
    return []
  }

  async updateEvent(id: string, patch: Partial<PotluckEvent>, adminTokenHash?: string): Promise<void> {
    if (!adminTokenHash) throw new Error('The admin link is needed to edit an event. Open the event with its admin link.')
    const { error } = await this.client().rpc('update_event_as_admin', {
      p_event_id: id,
      p_admin_token_hash: adminTokenHash,
      p_patch: patch,
    })
    if (error) throw new Error(`Supabase request failed: ${error.message}`)
  }

  async listSignups(eventId: string): Promise<Signup[]> {
    const { data, error } = await this.client()
      .from('signups')
      .select('*')
      .eq('event_id', eventId)
      .order('created_at', { ascending: true })
    if (error) throw new Error(`Supabase request failed: ${error.message}`)
    return cleanSignupList((data ?? []).map((r) => this.signupFromRow(r as Record<string, unknown>)))
  }

  async addSignup(signup: Signup): Promise<void> {
    const { error } = await this.client().from('signups').insert(this.signupRow(signup))
    if (error) throw new Error(`Supabase request failed: ${error.message}`)
  }

  async updateSignup(id: string, patch: Partial<Signup>, editTokenHash?: string): Promise<void> {
    const hash = editTokenHash ?? (await storedEditTokenHash(id))
    if (!hash) throw new Error('Only the browser that signed up can edit this dish.')
    const { error } = await this.client().rpc('update_signup', {
      p_signup_id: id,
      p_token_hash: hash,
      p_patch: patch,
    })
    if (error) throw new Error(`Supabase request failed: ${error.message}`)
  }

  async removeSignup(
    id: string,
    opts: { eventId: string; editTokenHash?: string; adminTokenHash?: string } = { eventId: this.eventId },
  ): Promise<void> {
    if (opts.adminTokenHash) {
      const { error } = await this.client().rpc('delete_signup_as_admin', {
        p_event_id: opts.eventId,
        p_admin_token_hash: opts.adminTokenHash,
        p_signup_id: id,
      })
      if (error) throw new Error(`Supabase request failed: ${error.message}`)
      return
    }
    const hash = opts.editTokenHash ?? (await storedEditTokenHash(id))
    if (!hash) throw new Error('Only the browser that signed up can remove this dish.')
    const { error } = await this.client().rpc('delete_signup', { p_signup_id: id, p_token_hash: hash })
    if (error) throw new Error(`Supabase request failed: ${error.message}`)
  }

  /**
   * The single-event UI never runs an explicit create-event step, so
   * add() first makes sure the bound event row exists. The insert is
   * ignore-on-conflict: an event the host already created (through
   * createEvent) is never overwritten. The admin token for an
   * auto-created event is minted here and kept in this browser,
   * under the same rule as guest edit tokens: only its hash is sent.
   */
  private async ensureEvent(): Promise<void> {
    const key = `potluck:admin-token:${this.eventId}`
    let token = localStorage.getItem(key)
    if (!token) {
      token = crypto.randomUUID()
      localStorage.setItem(key, token)
    }
    const { error } = await this.client()
      .from('events')
      .upsert(
        {
          id: this.eventId,
          name: this.eventId === DEFAULT_EVENT_ID ? 'Friendsgiving' : this.eventId,
          date: null,
          headcount: 0,
          targets: DEFAULT_TARGETS,
          dietary_needs: EMPTY_DIETARY_NEEDS,
          admin_token_hash: await sha256Hex(token),
        },
        { onConflict: 'id', ignoreDuplicates: true },
      )
    if (error) throw new Error(`Supabase request failed: ${error.message}`)
  }

  async list(): Promise<Signup[]> {
    return this.listSignups(this.eventId)
  }

  async add(signup: Signup): Promise<void> {
    const prepared: Signup = { ...(await withEditToken(signup)), eventId: signup.eventId || this.eventId }
    if (prepared.eventId === this.eventId) await this.ensureEvent()
    await this.addSignup(prepared)
  }

  async update(id: string, patch: Partial<Signup>): Promise<void> {
    await this.updateSignup(id, patch)
  }

  async remove(id: string): Promise<void> {
    await this.removeSignup(id, { eventId: this.eventId })
  }
}

export function createStore(mode: StoreMode): SignupStore {
  switch (mode) {
    case 'url':
      return new UrlSnapshotStore()
    case 'apps-script':
      return new AppsScriptStore()
    case 'supabase':
      return new SupabaseStore()
    case 'local':
    default:
      return new LocalStore()
  }
}
