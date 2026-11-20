export interface SpindleCssComponentRegistrationOptions {
  name: string
  selector: string
  category: string
}

export interface SpindleCssComponentRegistration extends SpindleCssComponentRegistrationOptions {
  id: string
  extensionId: string
  generation: number
}

export const MAX_CSS_COMPONENTS_PER_EXTENSION = 64
export const MAX_CSS_COMPONENTS_TOTAL = 256

const COMPONENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const CATEGORY_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/
const COMPONENT_SELECTOR_PATTERN = /^\s*\[data-component\s*=\s*["']([A-Za-z][A-Za-z0-9_-]{0,63})["']\s*\]\s*$/

const registrations: SpindleCssComponentRegistration[] = []
let nextRegistrationId = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeOptions(value: unknown): SpindleCssComponentRegistrationOptions {
  if (!isRecord(value)) throw new Error('CSS_COMPONENT_INVALID_OPTIONS')
  const keys = Object.keys(value).sort()
  if (keys.length !== 3 || keys[0] !== 'category' || keys[1] !== 'name' || keys[2] !== 'selector') {
    throw new Error('CSS_COMPONENT_INVALID_OPTIONS')
  }
  const { name, selector, category } = value
  if (
    typeof name !== 'string'
    || !COMPONENT_NAME_PATTERN.test(name)
    || typeof category !== 'string'
    || !CATEGORY_PATTERN.test(category)
    || typeof selector !== 'string'
  ) {
    throw new Error('CSS_COMPONENT_INVALID_OPTIONS')
  }
  const selectorMatch = COMPONENT_SELECTOR_PATTERN.exec(selector)
  if (!selectorMatch || selectorMatch[1] !== name) {
    throw new Error('CSS_COMPONENT_SELECTOR_INVALID')
  }
  return Object.freeze({
    name,
    selector: `[data-component="${name}"]`,
    category,
  })
}

export function registerCssComponent(
  extensionId: string,
  generation: number,
  value: unknown,
  registrationId = `${extensionId}:${generation}:${nextRegistrationId++}`,
): () => void {
  const options = normalizeOptions(value)
  const extensionCount = registrations.filter(
    (registration) => registration.extensionId === extensionId && registration.generation === generation,
  ).length
  if (extensionCount >= MAX_CSS_COMPONENTS_PER_EXTENSION || registrations.length >= MAX_CSS_COMPONENTS_TOTAL) {
    throw new Error('CSS_COMPONENT_LIMIT_REACHED')
  }
  const registration = Object.freeze({
    ...options,
    id: registrationId,
    extensionId,
    generation,
  })
  registrations.push(registration)
  let active = true
  return () => {
    if (!active) return
    active = false
    const index = registrations.indexOf(registration)
    if (index !== -1) registrations.splice(index, 1)
  }
}

export function getCssComponentRegistrations(): readonly SpindleCssComponentRegistration[] {
  return Object.freeze([...registrations])
}

export function clearCssComponentsForExtension(extensionId: string, generation?: number): void {
  for (let index = registrations.length - 1; index >= 0; index -= 1) {
    const registration = registrations[index]
    if (registration.extensionId === extensionId && (generation === undefined || registration.generation === generation)) {
      registrations.splice(index, 1)
    }
  }
}

export function resetCssComponentRegistryForTests(): void {
  registrations.splice(0)
  nextRegistrationId = 1
}
