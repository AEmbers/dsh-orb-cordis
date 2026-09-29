/** Nested model menu rows. Thinking models use a radio submenu; other models are checkboxes. */

export interface MenuSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface MenuEffort {
  readonly id: string
  readonly name: string
}

export interface MenuModel {
  readonly id: string
  readonly name: string
  readonly reasoning?: {
    readonly efforts: readonly MenuEffort[]
    readonly defaultEffort?: string
  }
}

export interface MenuGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly MenuModel[]
}

export interface MenuCatalog {
  readonly groups?: readonly MenuGroup[]
}

export interface MenuItem {
  label?: string
  type?: 'checkbox' | 'radio' | 'separator'
  checked?: boolean
  enabled?: boolean
  submenu?: MenuItem[]
  click?: (item: { checked: boolean }) => void
}

export interface MenuLabels {
  readonly empty: string
  readonly defaultEffort: string
}

const CURRENT_MODEL_MARK = '✓ '

/** Provider headers, model rows, and effort radios. An empty catalog is one disabled row. */
export function modelMenuItems(
  catalog: MenuCatalog | undefined,
  current: MenuSelection,
  onSelect: (selection: MenuSelection) => void,
  labels: MenuLabels,
): MenuItem[] {
  const groups = catalog?.groups ?? []
  if (groups.length === 0) return [{ label: labels.empty, enabled: false }]
  const items: MenuItem[] = []
  for (const group of groups) {
    items.push({ label: group.name, enabled: false })
    for (const model of group.models) items.push(modelItem(group.id, model, current, onSelect, labels.defaultEffort))
  }
  return items
}

function modelItem(
  provider: string,
  model: MenuModel,
  current: MenuSelection,
  onSelect: (selection: MenuSelection) => void,
  defaultEffortLabel: string,
): MenuItem {
  const selected = current.provider === provider && current.model === model.id
  const efforts = effortItems(provider, model, current, onSelect, defaultEffortLabel)
  if (efforts === undefined) {
    return {
      label: model.name,
      type: 'checkbox',
      checked: selected,
      click: () => { onSelect({ provider, model: model.id }) },
    }
  }
  return {
    label: selected ? `${CURRENT_MODEL_MARK}${model.name}` : model.name,
    submenu: efforts,
  }
}

function effortItems(
  provider: string,
  model: MenuModel,
  current: MenuSelection,
  onSelect: (selection: MenuSelection) => void,
  defaultEffortLabel: string,
): MenuItem[] | undefined {
  const reasoning = model.reasoning
  if (reasoning === undefined) return undefined
  const selected = current.provider === provider && current.model === model.id
  const effective = selected ? current.reasoningEffort ?? reasoning.defaultEffort : undefined
  const items: MenuItem[] = []
  if (reasoning.defaultEffort === undefined) {
    items.push({
      label: defaultEffortLabel,
      type: 'radio',
      checked: selected && current.reasoningEffort === undefined,
      click: () => { onSelect({ provider, model: model.id }) },
    })
  }
  for (const effort of reasoning.efforts) {
    items.push({
      label: effort.name,
      type: 'radio',
      checked: effective === effort.id,
      click: () => { onSelect({ provider, model: model.id, reasoningEffort: effort.id }) },
    })
  }
  return items.length === 0 ? undefined : items
}
