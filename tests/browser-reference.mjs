import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Canvas / Worker reference runs in an independent browser, without a desktop host.
export async function browserReference() {
  const root = path.resolve('out/tauri')
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    const target = path.resolve(root, '.' + pathname)
    try {
      assert.ok(target.startsWith(root + path.sep))
      response.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : 'text/html')
      response.end(pathname === '/reference.html' ? '<!doctype html><title>DustDesk canvas reference</title>' : await readFile(target))
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true })
    const page = await browser.newPage()
    await page.goto('http://127.0.0.1:'+server.address().port+'/reference.html')
    return { page, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)) } }
  } catch (error) { await browser?.close(); await new Promise(resolve => server.close(resolve)); throw error }
}
