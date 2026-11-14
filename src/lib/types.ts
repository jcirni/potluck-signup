export const COURSES = [
  'Appetizers',
  'Mains',
  'Veggies',
  'Sides',
  'Desserts',
  'Drinks',
  'Supplies',
] as const

export type Course = (typeof COURSES)[number]

/** Host-set dietary needs for the event, as guest counts. */
export interface DietaryNeeds {
  vegetarian: number
  vegan: number
  glutenFree: number
  noPork: number
}

export const EMPTY_DIETARY_NEEDS: DietaryNeeds = {
  vegetarian: 0,
  vegan: 0,
  glutenFree: 0,
  noPork: 0,
}

export interface PotluckEvent {
  /** URL-safe slug, used as ?event= in the share link. */
  id: string
  name: string
  /** YYYY-MM-DD, or '' when not set yet. */
  date: string
  /** Expected headcount; 0 means not stated. RSVPs (below) are the actual count. */
  headcount: number
  targets: Targets
  dietaryNeeds: DietaryNeeds
  createdAt: string
}

export interface Rsvp {
  id: string
  eventId: string
  name: string
  adults: number
  kids: number
  createdAt: string
}

export interface Signup {
  id: string
  eventId: string
  /** Catalog dish or supply id, when the signup claimed one. Free-text signups have none. */
  dishId?: string
  /** Recipe scale the cook chose (1 = as written). Only for catalog dishes. */
  scale?: number
  name: string
  dish: string
  course: Course
  needOven: boolean
  allergies: string
  /** Servings the dish covers; 0 means not stated. */
  servings: number
  createdAt: string
  /** SHA-256 hex of the guest's edit token; the token itself is never stored server-side. */
  editTokenHash?: string
  /** True for the four entries copied from the 2024 Friendsgiving sheet. */
  sample?: boolean
}

export type Targets = Record<Course, number>

/** Defaults for a roughly 12-15 person Friendsgiving. Editable in the UI. */
export const DEFAULT_TARGETS: Targets = {
  Appetizers: 2,
  Mains: 3,
  Veggies: 2,
  Sides: 3,
  Desserts: 2,
  Drinks: 3,
  Supplies: 4,
}

export function isCourse(value: string): value is Course {
  return (COURSES as readonly string[]).includes(value)
}

/** Lowercase slug from an event name, e.g. "Friendsgiving 2026" -> "friendsgiving-2026". */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `potluck-${Math.random().toString(36).slice(2, 8)}`
}
