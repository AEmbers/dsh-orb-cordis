/** Host model catalog reduced to the fields the ball menu and the settings page render. */

export interface CatalogEffort {
  readonly id: string
  readonly name: string
}

export interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly reasoning?: {
    readonly efforts: readonly CatalogEffort[]
    readonly defaultEffort?: string
  }
}

export interface CatalogGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly CatalogModel[]
}

export interface ModelCatalog {
  readonly groups: readonly CatalogGroup[]
}

/** Accept the official `modelCatalog()` object, or an empty catalog when it is missing. */
export function normalizeCatalog(value: unknown): ModelCatalog {
  const groups = asRecord(value)?.groups
  if (!Array.isArray(groups)) return { groups: [] }
  const normalized: CatalogGroup[] = []
  for (const group of groups) {
    const record = asRecord(group)
    if (record === undefined || typeof record.id !== 'string' || typeof record.name !== 'string') continue
    if (!Array.isArray(record.models)) continue
    const models: CatalogModel[] = []
    for (const model of record.models) {
      const item = asRecord(model)
      if (item === undefined || typeof item.id !== 'string' || typeof item.name !== 'string') continue
      const reasoning = reasoningOf(item.reasoning)
      models.push({
        id: item.id,
        name: item.name,
        ...reasoning === undefined ? {} : { reasoning },
      })
    }
    if (models.length > 0) normalized.push({ id: record.id, name: record.name, models })
  }
  return { groups: normalized }
}

function reasoningOf(value: unknown): CatalogModel['reasoning'] | undefined {
  const record = asRecord(value)
  if (record === undefined || !Array.isArray(record.efforts)) return undefined
  const efforts: CatalogEffort[] = []
  for (const effort of record.efforts) {
    const item = asRecord(effort)
    if (item === undefined || typeof item.id !== 'string' || typeof item.name !== 'string') continue
    efforts.push({ id: item.id, name: item.name })
  }
  if (efforts.length === 0) return undefined
  const defaultEffort = typeof record.defaultEffort === 'string' && record.defaultEffort !== ''
    ? record.defaultEffort
    : undefined
  return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
