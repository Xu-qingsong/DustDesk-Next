import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'

const artifacts = path.resolve('artifacts/tauri-migration/lan-dialog')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function command(executable, args) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), chunks = [], errors = []
  child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => errors.push(bytes))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  return { code, output: Buffer.concat(chunks).toString(), error: Buffer.concat(errors).toString() }
}
function driver() {
  const child = spawn(path.resolve('src-tauri/target/debug/examples/lan-dialog.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const replies = new Map(), events = [], lines = [], errors = []
  let sequence = 0, closed = false
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { closed = true; resolve({ code, signal }) }) })
  child.stderr.on('data', bytes => errors.push(bytes.toString()))
  child.stdin.on('error', error => { if (!closed && error.code !== 'EPIPE') errors.push(error.message) })
  createInterface({ input: child.stdout }).on('line', line => {
    lines.push(line); const value = JSON.parse(line)
    if (value.id && replies.has(value.id)) { replies.get(value.id)(value); replies.delete(value.id) } else events.push(value)
  })
  const send = value => child.stdin.write(JSON.stringify(value) + '\n')
  return { child, exited, lines, errors, send,
    async ready() {
      const deadline = Date.now() + 10_000
      while (!events.some(value => value.event === 'ready') && !closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      assert.ok(events.some(value => value.event === 'ready'), 'native dialog fixture not ready: ' + errors.join(''))
    },
    call(value) {
      const id = String(++sequence)
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { replies.delete(id); reject(Error('native dialog command timed out')) }, 20_000)
        replies.set(id, reply => { clearTimeout(timer); resolve(reply) })
      })
      result.catch(() => {}); send({ ...value, id }); return result
    },
    async stop() { if (!closed) child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n'); return exited },
    async kill() { if (!closed) child.kill('SIGKILL'); return exited },
  }
}

test('Windows native LAN dialogs default to decline and discard canceled choices', { timeout: 240_000 }, async () => {
  const report = { verified: false, productionReady: false, migrationComplete: false,
    scope: 'Actual native Windows LAN confirmation primitive and cancellation via dedicated fixture; no desktop host/IPC or transfer/path grant', checks: [] }
  const drivers = []; let fixture
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-lan-dialog-'))
  const downloads = path.join(root, 'not-created-downloads'), original = path.join(root, 'original')
  const peer = { id: 'peer', name: '设备\n123456\u202e', address: '127.0.0.1', port: 4567, fingerprint: 'a'.repeat(64), lastSeen: 0 }
  const manifest = { id: 'task', name: '测试文件', entries: [], directories: [] }
  const receive = extra => ({ command: 'receive', peer, manifest, downloads, ...extra })
  const pair = { command: 'pair', peer, code: '012345' }
  const titles = { pair: '局域网设备配对', receive: '接收局域网内容' }
  const check = name => report.checks.push(name)
  async function start() { fixture = driver(); drivers.push(fixture); await fixture.ready(); return fixture }
  async function ui(title, action = 'snapshot', button) {
    const result = await command('pwsh', ['-NoProfile', '-STA', '-File', 'tests/tauri-lan-dialog.ps1', '-ProcessId', String(fixture.child.pid), '-Title', title, '-Action', action, ...(button ? ['-Button', button] : [])])
    assert.equal(result.code, 0, result.error)
    return ['snapshot', 'absent'].includes(action) ? JSON.parse(result.output) : result.output
  }
  async function snapshot(title) { const state = await ui(title); report.windows ??= []; report.windows.push(state); assert.equal(state.visible, true); return state }
  const names = state => state.controls.map(control => control.name).join('\n')
  const buttons = state => state.controls.filter(control => control.type === 'ControlType.Button').map(control => control.name)
  try {
    await fs.mkdir(artifacts, { recursive: true })
    const built = await command('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'lan-dialog'])
    await fs.writeFile(path.join(artifacts, 'build.log'), built.output + built.error); assert.equal(built.code, 0)
    const inputs = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/src/lib.rs', 'src-tauri/src/lan/mod.rs', 'src-tauri/src/lan/dialog.rs', 'src-tauri/src/lan/protocol.rs', 'src-tauri/src/lan/receiver.rs', 'src-tauri/examples/lan-dialog.rs', 'tests/tauri-lan-dialog.mjs', 'tests/tauri-lan-dialog.ps1']
    report.inputs = Object.fromEntries(await Promise.all(inputs.map(async name => [name, hash(await fs.readFile(name))])))
    report.driver = { executable: path.resolve('src-tauri/target/debug/examples/lan-dialog.exe'), sha256: hash(await fs.readFile('src-tauri/target/debug/examples/lan-dialog.exe')) }
    await start()
    let pending = fixture.call(pair)
    let state = await snapshot(titles.pair)
    assert.ok(names(state).includes('012345')); assert.ok(names(state).includes('127.0.0.1:4567'))
    assert.ok(names(state).includes('设备\\u000a123456\\u202e'))
    assert.ok(buttons(state).includes('取消'))
    await ui(titles.pair, 'default'); assert.equal((await pending).value.accepted, false)
    check('actual pair dialog renders exact code/address and literal peer name; default keyboard Enter declines')

    pending = fixture.call(pair); await snapshot(titles.pair); await ui(titles.pair, 'click', '配对码一致，继续')
    assert.equal((await pending).value.accepted, true)
    pending = fixture.call(pair); await snapshot(titles.pair); await ui(titles.pair, 'escape')
    assert.equal((await pending).value.accepted, false)
    check('pairing requires actual explicit native accept; Escape declines')

    pending = fixture.call(receive()); state = await snapshot(titles.receive)
    assert.ok(names(state).includes(downloads)); assert.ok(buttons(state).includes('选择接收目录'))
    await ui(titles.receive, 'click', '选择接收目录'); assert.equal((await pending).value.choice, 'choose')
    assert.equal(await fs.stat(downloads).then(() => true, () => false), false)
    check('new file offer shows native default directory and returns choose request without creating or approving a directory')

    pending = fixture.call(receive()); await snapshot(titles.receive); await ui(titles.receive, 'click', '接收到默认目录')
    assert.equal((await pending).value.choice, 'accept')
    pending = fixture.call(receive()); await snapshot(titles.receive); await ui(titles.receive, 'default')
    assert.equal((await pending).value.choice, 'decline')
    check('new file offer explicit default-directory acceptance differs from default keyboard decline')

    pending = fixture.call(receive({ existing: original })); state = await snapshot(titles.receive)
    assert.ok(names(state).includes(original)); assert.equal(names(state).includes(downloads), false)
    assert.equal(buttons(state).includes('选择接收目录'), false)
    await ui(titles.receive, 'click', '接收'); assert.equal((await pending).value.choice, 'accept')
    check('resume requires a new native decision showing exact original directory, with no change-directory button')

    const text = '字'.repeat(1999) + '😀hidden suffix'
    pending = fixture.call(receive({ manifest: { ...manifest, text } })); state = await snapshot(titles.receive)
    assert.equal(buttons(state).includes('选择接收目录'), false)
    assert.equal(names(state).includes('hidden suffix'), false); assert.equal(names(state).includes('😀'), false)
    assert.ok(names(state).includes('…')); await ui(titles.receive, 'click', '接收')
    assert.equal((await pending).value.choice, 'accept')
    check('text preview is bounded without splitting astral characters, never offers a directory and accepts only explicitly')

    assert.equal((await fixture.call({ ...pair, code: 'bad' })).ok, false)
    assert.equal((await fixture.call({ ...pair, owner: 1 })).ok, false)
    assert.equal((await ui(titles.pair, 'absent')).absent, true)
    check('invalid pairing code and invalid native owner fail without opening a dialog')

    pending = fixture.call(pair); await snapshot(titles.pair); fixture.send({ command: 'cancel' })
    const canceled = await pending; assert.equal(canceled.ok, false); assert.match(canceled.error, /取消/)
    assert.equal((await ui(titles.pair, 'absent')).absent, true)
    assert.equal((await fixture.stop()).code, 0)
    await start(); fixture.send({ command: 'cancel' })
    assert.equal((await fixture.call(pair)).ok, false); assert.equal((await ui(titles.pair, 'absent')).absent, true)
    assert.equal((await fixture.stop()).code, 0)
    await start(); pending = fixture.call(receive()); await snapshot(titles.receive)
    const stopped = fixture.stop(); assert.equal((await pending).ok, false); assert.equal((await stopped).code, 0)
    check('cancel while visible, cancellation before show and stop during modal UI all reject results, close windows and join fixture threads')
    assert.equal(drivers.every(fixture => fixture.child.exitCode !== null), true)
    report.remainingProcesses = 0; report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally {
    for (const fixture of drivers) if (fixture.child.exitCode === null && fixture.child.signalCode === null) await fixture.kill()
    await fs.mkdir(artifacts, { recursive: true })
    await fs.writeFile(path.join(artifacts, 'events.log'), drivers.flatMap(fixture => [...fixture.lines, ...fixture.errors]).join('\n'))
    await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
    await fs.rm(root, { recursive: true, force: true })
  }
})
