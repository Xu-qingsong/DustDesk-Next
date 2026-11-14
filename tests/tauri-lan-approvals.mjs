import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'

const artifacts = path.resolve('artifacts/tauri-migration/lan-approvals')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function command(executable, args) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), output = [], errors = []
  child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => errors.push(bytes))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  return { code, output: Buffer.concat(output).toString(), error: Buffer.concat(errors).toString() }
}
function driver(downloads, timeout) {
  const child = spawn(path.resolve('src-tauri/target/debug/examples/lan-approvals.exe'), [downloads, String(timeout)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const replies = new Map(), events = [], lines = [], errors = []; let sequence = 0, closed = false
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => {
    closed = true
    for (const [id, reply] of replies) reply({ id, ok: false, error: 'fixture closed' })
    replies.clear(); resolve({ code, signal })
  }) })
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
      assert.ok(events.some(value => value.event === 'ready'), errors.join(''))
    },
    call(value) {
      const id = String(++sequence)
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { replies.delete(id); reject(Error('approval request timed out')) }, 55_000)
        replies.set(id, reply => { clearTimeout(timer); resolve(reply) })
      })
      reply.catch(() => {}); send({ ...value, id }); return { id, reply }
    },
    async stop() { if (!closed) child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n'); return exited },
    async kill() { if (!closed) child.kill('SIGKILL'); return exited },
  }
}

test('native LAN approval queue serializes decisions and joins canceled folder pickers', { timeout: 240_000 }, async () => {
  const report = { verified: false, productionReady: false, migrationComplete: false,
    scope: 'Actual Windows native approval queue and folder selection; isolated development fixture, no desktop IPC, network trust or production path grant', checks: [] }
  const drivers = []; let fixture
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-lan-approvals-'))
  const downloads = path.join(root, 'uncreated-default'), selected = path.join(root, '已选择 中文'), original = path.join(root, '续传原目录')
  const peer = { id: 'peer', name: '设备', address: '127.0.0.1', port: 4567, fingerprint: 'a'.repeat(64), lastSeen: 0 }
  const manifest = { id: 'task', name: '测试文件', entries: [], directories: [] }
  const pair = { command: 'pair', peer, code: '012345' }, receive = extra => ({ command: 'receive', peer, manifest, ...extra })
  const titles = { pair: '局域网设备配对', receive: '接收局域网内容', folder: '选择局域网接收目录' }
  const check = name => report.checks.push(name)
  async function start(timeout = 45_000) { fixture = driver(downloads, timeout); drivers.push(fixture); await fixture.ready() }
  async function dialog(title, action = 'snapshot', button) {
    const result = await command('pwsh', ['-NoProfile', '-STA', '-File', 'tests/tauri-lan-dialog.ps1', '-ProcessId', String(fixture.child.pid), '-Title', title, '-Action', action, ...(button ? ['-Button', button] : [])])
    assert.equal(result.code, 0, result.error); return ['snapshot', 'absent'].includes(action) ? JSON.parse(result.output) : result.output
  }
  async function folder(action = 'snapshot', target) {
    const result = await command('pwsh', ['-NoProfile', '-STA', '-File', 'tests/tauri-dialog.ps1', '-ProcessId', String(fixture.child.pid), '-Title', titles.folder, '-Action', action, ...(target ? ['-Path', target] : [])])
    assert.equal(result.code, 0, result.error); return action === 'snapshot' ? JSON.parse(result.output) : result.output
  }
  async function choose() { await dialog(titles.receive, 'click', '选择接收目录'); await folder('visible') }
  try {
    await fs.mkdir(artifacts, { recursive: true }); await fs.mkdir(selected); await fs.mkdir(original)
    const built = await command('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'lan-approvals'])
    await fs.writeFile(path.join(artifacts, 'build.log'), built.output + built.error); assert.equal(built.code, 0)
    const inputs = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/lib.rs', 'src-tauri/src/lan/mod.rs', 'src-tauri/src/lan/approvals.rs', 'src-tauri/src/lan/approvals_tests.rs', 'src-tauri/src/lan/dialog.rs', 'src-tauri/src/lan/folder.rs', 'src-tauri/src/lan/protocol.rs', 'src-tauri/src/lan/receiver.rs', 'src-tauri/examples/lan-approvals.rs', 'tests/tauri-lan-approvals.mjs', 'tests/tauri-lan-dialog.ps1', 'tests/tauri-dialog.ps1']
    report.inputs = Object.fromEntries(await Promise.all(inputs.map(async name => [name, hash(await fs.readFile(name))])))
    report.driver = { executable: path.resolve('src-tauri/target/debug/examples/lan-approvals.exe'), sha256: hash(await fs.readFile('src-tauri/target/debug/examples/lan-approvals.exe')) }
    await start()
    let pending = fixture.call(pair); assert.equal((await dialog(titles.pair)).visible, true)
    await dialog(titles.pair, 'click', '取消'); assert.equal((await pending.reply).value.accepted, false)
    pending = fixture.call(pair); await dialog(titles.pair, 'click', '配对码一致，继续'); assert.equal((await pending.reply).value.accepted, true)
    check('real queue pairing supports explicit native cancellation and acceptance; keyboard default is covered by the separate dialog suite')

    pending = fixture.call(receive()); await choose()
    const controls = await folder(); report.folderControls = controls
    assert.ok(controls.some(control => control.name.match(/选择文件夹|Select Folder/)))
    await folder('select', selected); assert.equal((await pending.reply).value.directory, selected)
    assert.equal(await fs.stat(downloads).then(() => true, () => false), false)
    check('choose-directory decision opens actual visible folder-only dialog and returns precisely the selected existing directory')

    pending = fixture.call(receive()); await choose(); await folder('cancel')
    assert.equal((await pending.reply).value.directory, null)
    assert.equal(await fs.stat(downloads).then(() => true, () => false), false)
    check('canceling actual folder chooser declines reception without a default-directory fallback or filesystem creation')

    pending = fixture.call(receive()); await dialog(titles.receive, 'click', '接收到默认目录')
    assert.equal((await pending.reply).value.directory, downloads)
    pending = fixture.call(receive({ existing: original })); const resumed = await dialog(titles.receive)
    assert.ok(resumed.controls.some(control => control.name.includes(original)))
    assert.equal(resumed.controls.some(control => control.name === '选择接收目录'), false)
    await dialog(titles.receive, 'click', '接收'); assert.equal((await pending.reply).value.directory, original)
    pending = fixture.call(receive({ manifest: { ...manifest, text: '文本' } })); await dialog(titles.receive, 'click', '接收')
    assert.equal((await pending.reply).value.directory, downloads)
    assert.equal((await dialog(titles.folder, 'absent')).absent, true)
    check('explicit default, exact original resume directory and text acceptance preserve their separate semantics')

    const first = fixture.call(pair); await dialog(titles.pair)
    const waiting = fixture.call(receive()); fixture.send({ command: 'cancel', target: waiting.id }); assert.equal((await waiting.reply).ok, false)
    assert.equal((await dialog(titles.receive, 'absent')).absent, true)
    await dialog(titles.pair, 'click', '配对码一致，继续'); assert.equal((await first.reply).value.accepted, true)
    pending = fixture.call(pair); assert.equal((await dialog(titles.pair)).visible, true)
    await dialog(titles.pair, 'click', '取消'); assert.equal((await pending.reply).value.accepted, false)
    assert.equal((await dialog(titles.receive, 'absent')).absent, true)
    check('pair and receive requests serialize; a dropped queued network request never opens its native modal')

    pending = fixture.call(receive()); await choose(); fixture.send({ command: 'cancel', target: pending.id }); assert.equal((await pending.reply).ok, false)
    pending = fixture.call(pair); await dialog(titles.pair)
    assert.equal((await dialog(titles.folder, 'absent')).absent, true)
    await dialog(titles.pair, 'click', '取消'); assert.equal((await pending.reply).value.accepted, false)
    check('canceling a live native folder chooser closes it before the next queued confirmation is displayed')
    assert.equal((await fixture.stop()).code, 0)

    await start(5_000); pending = fixture.call(pair); assert.equal((await dialog(titles.pair)).visible, true)
    assert.equal((await pending.reply).ok, false); assert.equal((await dialog(titles.pair, 'absent')).absent, true)
    assert.equal((await fixture.stop()).code, 0)
    check('actual native confirmation timeout rejects and joins its visible modal')

    await start(); pending = fixture.call(receive()); await choose()
    const stopped = fixture.stop(); assert.equal((await pending.reply).ok, false); assert.equal((await stopped).code, 0)
    assert.equal((await dialog(titles.folder, 'absent')).absent, true)
    check('stop during a real folder chooser cancels pending approval and waits for STA/modal/thread cleanup')

    await start(); pending = fixture.call(receive()); await dialog(titles.receive)
    fixture.send({ command: 'invalidate' }); assert.equal((await pending.reply).ok, false)
    assert.equal((await dialog(titles.receive, 'absent')).absent, true)
    assert.equal((await fixture.call(pair).reply).ok, false); assert.equal((await fixture.stop()).code, 0)
    check('host revocation closes the active confirmation and refuses subsequent requests')
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
