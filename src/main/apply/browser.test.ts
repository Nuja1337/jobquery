import { describe, expect, it } from 'vitest'
import type { BrowserContext } from 'playwright-core'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { BrowserManager, withTimeout } from './browser'

/** A tab that remembers its address, the close listeners it was given and the timeout set on it. */
function fakePage(url = 'about:blank') {
  const listeners: Array<() => void> = []
  const page = {
    url: () => url,
    once: (_event: string, fn: () => void) => void listeners.push(fn),
    setDefaultTimeout: (ms: number) => void (page.timeout = ms),
    timeout: 0,
    close: () => listeners.splice(0).forEach((fn) => fn())
  }
  return page
}

function managerWith(pages: Array<ReturnType<typeof fakePage>>) {
  const manager = new BrowserManager('unused')
  const context = {
    pages: () => pages,
    newPage: async () => {
      const page = fakePage()
      pages.push(page)
      return page
    }
  }
  ;(manager as unknown as { visible: BrowserContext }).visible = context as unknown as BrowserContext
  return manager
}

describe('BrowserManager.newVisiblePage', () => {
  it('hands a blank tab to one caller only', async () => {
    const blank = fakePage()
    const manager = managerWith([blank])
    const first = await manager.newVisiblePage(DEFAULT_SETTINGS.browser)
    const second = await manager.newVisiblePage(DEFAULT_SETTINGS.browser)
    expect(first).toBe(blank)
    expect(second).not.toBe(blank)
  })

  it('offers the blank tab again after it was closed', async () => {
    const blank = fakePage()
    const pages = [blank]
    const manager = managerWith(pages)
    const first = (await manager.newVisiblePage(DEFAULT_SETTINGS.browser)) as unknown as ReturnType<typeof fakePage>
    first.close()
    const again = await manager.newVisiblePage(DEFAULT_SETTINGS.browser)
    expect(again).toBe(blank)
  })

  it('does not take a tab that shows a page', async () => {
    const used = fakePage('https://example.com/')
    const manager = managerWith([used])
    expect(await manager.newVisiblePage(DEFAULT_SETTINGS.browser)).not.toBe(used)
  })

  it('puts a default timeout on every tab it hands out', async () => {
    const manager = managerWith([])
    const page = (await manager.newVisiblePage(DEFAULT_SETTINGS.browser)) as unknown as ReturnType<typeof fakePage>
    expect(page.timeout).toBe(30_000)
  })
})

describe('withTimeout', () => {
  it('passes a result through and rejects a page script that never answers', async () => {
    await expect(withTimeout(Promise.resolve(5), 50)).resolves.toBe(5)
    await expect(withTimeout(new Promise<never>(() => {}), 20)).rejects.toThrow(/took too long/)
  })
})

