import assert from 'node:assert/strict'

// Choose through the visible UI, including searchable lists and popup portals.
export async function chooseSelect(locator, value) {
  await locator.click()
  const page = locator.page()
  const item = page.locator(`[data-control-option][data-control-value=${JSON.stringify(String(value))}]`)
  await item.waitFor({ state: 'visible' })
  await item.click()
  assert.equal(await locator.getAttribute('aria-expanded'), 'false')
}
