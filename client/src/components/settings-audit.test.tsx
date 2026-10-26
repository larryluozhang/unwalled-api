// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { ThemeContext } from '@/theme-context'
import { SettingsDialog } from './settings-dialog'

const initial = {
  enabled: true,
  platform_overrides: { groq: true, 'siliconflow-cn': false },
  paid_platforms: ['siliconflow', 'siliconflow-cn'],
}
let current = structuredClone(initial)
let puts: unknown[] = []
let root: Root
let container: HTMLDivElement

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
async function flush() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })

beforeEach(() => {
  current = structuredClone(initial)
  puts = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/settings/audit')) {
      if (init?.method === 'PUT') {
        const patch = JSON.parse(String(init.body))
        puts.push(patch)
        current = { ...current, ...patch, platform_overrides: { ...current.platform_overrides, ...(patch.platform_overrides ?? {}) } }
      }
      return json(current)
    }
    if (url.endsWith('/api/settings/update-check')) return json({ enabled: false })
    if (url.endsWith('/api/settings/compression')) return json({})
    if (url.endsWith('/api/settings/version')) return json({ version: null })
    if (url.endsWith('/api/update/status')) return json({ status: 'disabled', version: null, baseBranch: 'main' })
    return json({}, 200)
  }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mountAudit() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <ThemeContext.Provider value={{ theme: 'light', setTheme: () => {}, resolvedDark: false }}>
            <SettingsDialog open onOpenChange={() => {}} />
          </ThemeContext.Provider>
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
  await flush()
  const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Audit')!
  await act(async () => { button.click() })
  await flush()
}

describe('Settings audit section', () => {
  it('shows paid-off defaults and saves a global toggle immediately without the compression footer', async () => {
    await mountAudit()
    expect(document.body.textContent).toContain('Daily model audit')
    expect(document.body.textContent).toContain('siliconflow-cn')
    expect(document.body.textContent).not.toContain('Save changes')
    const switches = [...document.querySelectorAll('[data-slot="switch"]')]
    expect(switches.length).toBeGreaterThan(1)
    await act(async () => { (switches[0] as HTMLButtonElement).click() })
    await flush()
    expect(puts).toContainEqual({ enabled: false })
  })

  it('saves only the selected platform override', async () => {
    await mountAudit()
    const switches = [...document.querySelectorAll('[data-slot="switch"]')]
    await act(async () => { (switches.at(-1) as HTMLButtonElement).click() })
    await flush()
    expect(puts).toContainEqual({ platform_overrides: { 'siliconflow-cn': true } })
  })
})
