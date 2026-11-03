import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { chooseSelect } from './ui-controls.mjs'

let first, second
const roots = new Set()
const launch = async tempRoot => {
  const instance = await launchDustDesk({ tempRoot, showToolMenus: true })
  roots.add(instance.tempRoot)
  instance.window.setDefaultTimeout(15000)
  return instance
}
const navigate = (page, name) => page.locator('.sidebar').getByText(name, { exact: true }).click()
const snapshot = page => page.evaluate(() => window.dustdesk.toolbox.lanSnapshot())
const waitSnapshot = async (page, predicate, description) => {
  const deadline = Date.now() + 30000
  let value
  while (Date.now() < deadline) {
    value = await snapshot(page)
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`${description}: ${JSON.stringify(value.tasks.map(({ id, status, done, total, error }) => ({ id, status, done, total, error })))}`)
}
const waitStatus = (page, id, status) => waitSnapshot(page, value => value.tasks.find(task => task.id === id)?.status === status, `Task ${id} did not become ${status}`)
const quitPreserving = async instance => {
  const closed = new Promise(resolve => instance.electronApp.once('close', resolve))
  await instance.electronApp.evaluate(({ app }) => { setTimeout(() => app.quit(), 10) })
  let timer
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Normal application quit did not finish')), 30000) })]) }
  finally { clearTimeout(timer) }
}
const dialogs = (instance, source) => instance.electronApp.evaluate(({ dialog }, { source, receiveDirectory }) => {
  globalThis.holdReceive = false; globalThis.receiveHeld = false
  dialog.showMessageBox = async (...args) => {
    if (args.at(-1).title === '接收局域网内容' && globalThis.holdReceive) {
      globalThis.receiveHeld = true
      return new Promise(resolve => { globalThis.releaseReceive = response => resolve({ response }) })
    }
    return { response: args.at(-1).buttons.length === 3 ? 2 : 1 }
  }
  dialog.showOpenDialog = async (...args) => ({ canceled: false, filePaths: [args.at(-1).title === '选择接收目录' ? receiveDirectory : source] })
}, { source, receiveDirectory: path.join(instance.tempRoot, 'received') })
const connect = async (sender, receiver) => {
  await sender.getByLabel('设备 IPv4 地址', { exact: true }).fill('127.0.0.1')
  await sender.getByLabel('设备端口', { exact: true }).fill(String((await snapshot(receiver)).port))
  await sender.getByLabel('设备端口', { exact: true }).press('Tab')
  await sender.getByRole('button', { name: '连接', exact: true }).click()
  await sender.waitForFunction(() => document.querySelector('.lan-device.selected'))
}

try {
  first = await launch()
  let page = first.window
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await navigate(page, '文本工具箱')
  await page.getByRole('button', { name: '文本对比', exact: true }).click()
  await page.getByLabel('对比文本', { exact: true }).fill('对比草稿')
  await page.getByRole('button', { name: 'JSON 格式化', exact: true }).click()
  await page.waitForTimeout(400)
  assert.equal(await page.getByLabel('文本结果', { exact: true }).inputValue(), '')
  assert.equal(await page.locator('.toolbox-error:visible').count(), 0)
  await page.getByLabel('文本输入', { exact: true }).fill('{"ok":true}')
  await page.waitForFunction(() => document.querySelector('[aria-label="文本结果"]')?.value.includes('"ok": true'))
  await page.getByRole('button', { name: '文本对比', exact: true }).click()
  assert.equal(await page.getByLabel('对比文本', { exact: true }).inputValue(), '对比草稿')

  await navigate(page, '图片工具箱')
  await chooseSelect(page.getByLabel('格式', { exact: true }), 'png')
  assert.equal(await page.getByLabel('有损质量', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'JPG 背景', exact: true }).count(), 0)
  assert.equal(await page.getByRole('checkbox', { name: '允许放大小图', exact: true }).count(), 0)
  await chooseSelect(page.getByLabel('格式', { exact: true }), 'jpeg')
  await page.getByLabel('有损质量', { exact: true }).press('ArrowLeft')
  assert.equal(await page.getByRole('button', { name: 'JPG 背景', exact: true }).count(), 1)
  await chooseSelect(page.getByLabel('格式', { exact: true }), 'webp')
  assert.equal(await page.getByLabel('有损质量', { exact: true }).inputValue(), '84')
  assert.equal(await page.getByRole('button', { name: 'JPG 背景', exact: true }).count(), 0)
  await chooseSelect(page.getByLabel('格式', { exact: true }), 'original')
  assert.equal(await page.getByRole('button', { name: 'JPG 背景', exact: true }).count(), 1)
  await chooseSelect(page.getByLabel('尺寸调整', { exact: true }), 'percent')
  await chooseSelect(page.getByLabel('类型', { exact: true }), 'text')
  for (const label of ['比例 %', '边距 px', '水印大小']) {
    const input = page.getByLabel(label, { exact: true })
    assert.equal(await input.getAttribute('type'), 'text')
    assert.equal(await input.getAttribute('role'), null)
    assert.equal(await input.locator('..').locator('.control-number-actions').count(), 0)
  }
  assert.equal(await page.getByRole('checkbox', { name: '允许放大小图', exact: true }).count(), 1)
  await page.locator('.image-tool-layout > .panel').first().screenshot({ path: 'test-artifacts/image-options-simplified.png' })
  assert.deepEqual(errors, [])
  console.log('PASS: text parameter isolation and drafts; image format options and plain inputs')

  second = await launch()
  const source = path.join(first.tempRoot, 'source.bin')
  await fs.writeFile(source, Buffer.alloc(64 * 1024 * 1024, 77))
  await dialogs(first, source); await dialogs(second, source)
  for (const instance of [first, second]) {
    await navigate(instance.window, '局域网传输')
    await instance.window.getByRole('button', { name: '开启局域网传输', exact: true }).click()
    await waitSnapshot(instance.window, value => value.enabled && value.port > 0, 'LAN did not start')
  }
  await connect(page, second.window)
  await page.getByRole('button', { name: '文本', exact: true }).click()
  await page.getByLabel('发送文本', { exact: true }).fill('已结束记录')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('.lan-status.status-completed').waitFor()

  await second.electronApp.evaluate(() => { globalThis.holdReceive = true })
  await page.getByRole('button', { name: '文件 / 文件夹', exact: true }).click()
  await page.getByRole('button', { name: '添加文件', exact: true }).click()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('.lan-status.status-waiting').waitFor()
  assert.equal(await page.getByRole('button', { name: '添加文件', exact: true }).isEnabled(), true)
  await page.getByRole('button', { name: '文本', exact: true }).click()
  await page.getByLabel('发送文本', { exact: true }).fill('传输期间继续编辑')
  assert.equal(await page.getByRole('button', { name: '传输中', exact: true }).isDisabled(), true)
  const waiting = (await snapshot(page)).tasks.find(task => task.status === 'waiting')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await waitStatus(page, waiting.id, 'paused')
  await second.electronApp.evaluate(() => { globalThis.holdReceive = false; globalThis.releaseReceive(0) })

  const dialog = page.getByRole('alertdialog')
  await page.getByRole('button', { name: '清理已结束记录', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[role="alertdialog"] .secondary-button') === document.activeElement)
  await page.keyboard.press('Escape')
  assert.equal((await snapshot(page)).tasks.length, 2)
  await page.getByRole('button', { name: '清理已结束记录', exact: true }).click()
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await page.locator('.lan-status.status-completed').waitFor({ state: 'hidden' })
  assert.equal((await snapshot(page)).tasks.find(task => task.id === waiting.id).status, 'paused')
  await page.getByRole('button', { name: '删除未完成任务', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[role="alertdialog"] .secondary-button') === document.activeElement)
  await page.keyboard.press('Escape')
  assert.equal((await snapshot(page)).tasks.find(task => task.id === waiting.id).status, 'paused')
  await page.getByRole('button', { name: '删除未完成任务', exact: true }).click()
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await page.locator('.lan-task').waitFor({ state: 'hidden' })
  assert.equal((await fs.stat(source)).size, 64 * 1024 * 1024)
  console.log('PASS: background submission, editable send draft, duplicate-send guard, safe cleanup and deletion confirmation')

  // Throttle only the test sender's upload stream; hashing still uses normal reads.
  await first.electronApp.evaluate((_, source) => {
    const fs = process.getBuiltinModule('node:fs'), original = fs.createReadStream
    const { Transform } = process.getBuiltinModule('node:stream')
    fs.createReadStream = (target, options) => {
      const stream = original(target, options)
      if (String(target) !== source || options?.start === undefined) return stream
      const slow = new Transform({ transform(chunk, encoding, callback) { setTimeout(() => callback(null, chunk), 10) } })
      stream.on('error', error => slow.destroy(error))
      slow.on('close', () => stream.destroy())
      return stream.pipe(slow)
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
  }, source)
  await page.getByRole('button', { name: '文件 / 文件夹', exact: true }).click()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const receiving = await waitSnapshot(second.window, value => value.tasks.some(task => task.status === 'transferring' && task.done > 0 && task.done < task.total), 'Receiver did not write a partial file')
  const outgoing = (await snapshot(page)).tasks.find(task => task.direction === 'send')
  const incoming = receiving.tasks.find(task => task.status === 'transferring')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await waitStatus(page, outgoing.id, 'paused'); await waitStatus(second.window, incoming.id, 'paused')
  const staging = (await fs.readdir(incoming.directory)).find(name => name.startsWith('.dustdesk-part-'))
  assert.ok(staging)
  const partialSize = (await fs.stat(path.join(incoming.directory, staging, '0.part'))).size
  assert.ok(partialSize > 0 && partialSize < 64 * 1024 * 1024)
  await second.window.getByRole('button', { name: '删除未完成任务', exact: true }).click()
  await second.window.keyboard.press('Escape')
  assert.equal((await fs.stat(path.join(incoming.directory, staging, '0.part'))).size, partialSize)
  const firstRoot = first.tempRoot, secondRoot = second.tempRoot
  await quitPreserving(first); first = undefined
  await quitPreserving(second); second = undefined
  first = await launch(firstRoot); second = await launch(secondRoot); page = first.window
  await dialogs(first, source); await dialogs(second, source)
  for (const instance of [first, second]) {
    await navigate(instance.window, '局域网传输')
    await waitSnapshot(instance.window, value => value.enabled && value.port > 0, 'LAN did not restore')
  }
  assert.equal((await snapshot(page)).tasks.find(task => task.id === outgoing.id).status, 'paused')
  assert.equal((await snapshot(second.window)).tasks.find(task => task.id === incoming.id).status, 'paused')
  await connect(page, second.window)
  await page.getByRole('button', { name: '继续 / 重试', exact: true }).click()
  await waitStatus(page, outgoing.id, 'completed'); await waitStatus(second.window, incoming.id, 'completed')
  const output = await fs.readFile(path.join(incoming.directory, 'source.bin'))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  assert.equal(hash(output), hash(await fs.readFile(source)))
  assert.equal((await fs.readdir(incoming.directory)).some(name => name.startsWith('.dustdesk-part-')), false)
  await page.screenshot({ path: 'test-artifacts/lan-workflows-verified.png' })
  console.log('PASS: real partial transfer, normal quit of both Electron apps, restart and resume with identical SHA-256')
} finally {
  if (second) await closeDustDesk(second)
  if (first) await closeDustDesk(first)
  for (const root of roots) await fs.rm(root, { recursive: true, force: true })
}
