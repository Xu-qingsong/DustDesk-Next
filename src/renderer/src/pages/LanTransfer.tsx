import { NumberInput, Progress } from '../components/ui/FormControls'
import { useConfirmDialog } from '../components/ui/ConfirmDialog'
import { useEffect, useRef, useState } from 'react'
import { Radio, Monitor, Plus, FolderOpen, FilePlus, Send, X, Copy, Download } from 'lucide-react'
import { toast } from 'sonner'
import type { LanSnapshot, ToolAsset, TransferStatus } from '../../../shared/toolbox'
import { toolError } from '../../../shared/toolbox'
import { Panel } from '../components/common'
import { fileSize } from '../toolbox/format'

type TaskAction = 'pause' | 'resume' | 'cancel' | 'clear'
const taskStates: Record<TransferStatus, { label: string; actions: TaskAction[]; finished?: boolean }> = {
  preparing: { label: '准备中', actions: ['pause', 'cancel'] },
  waiting: { label: '等待接收', actions: ['pause', 'cancel'] },
  transferring: { label: '传输中', actions: ['pause', 'cancel'] },
  paused: { label: '已暂停', actions: ['resume', 'cancel', 'clear'] },
  failed: { label: '失败', actions: ['resume', 'cancel', 'clear'] },
  completed: { label: '已完成', actions: ['clear'], finished: true },
  canceled: { label: '已取消', actions: ['clear'], finished: true }
}
const actionLabels = { pause: '暂停', resume: '继续 / 重试', cancel: '取消' }

export function LanTransfer({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<LanSnapshot>({ enabled: false, devices: [], tasks: [], addresses: [], port: 0 })
  const [device, setDevice] = useState(''), [address, setAddress] = useState(''), [port, setPort] = useState(''), [assets, setAssets] = useState<ToolAsset[]>([])
  const [mode, setMode] = useState<'files' | 'text'>('files'), [text, setText] = useState(''), [error, setError] = useState('')
  const [pending, setPending] = useState<Set<string>>(new Set()), operations = useRef(new Set<string>()), currentAssets = useRef(assets)
  const { confirm, confirmationDialog } = useConfirmDialog()
  currentAssets.current = assets
  const busy = pending.has('form')
  const selectedDevice = snapshot.devices.find(peer => peer.id === device)
  const sending = snapshot.tasks.some(task => task.direction === 'send' && taskStates[task.status].actions.includes('pause'))
  const finishedTasks = snapshot.tasks.filter(task => taskStates[task.status].finished)

  useEffect(() => {
    if (!active) return
    let live = true
    const unsubscribe = window.dustdesk.toolbox.onLanChanged(value => { if (live) setSnapshot(value) })
    void window.dustdesk.toolbox.lanSnapshot().then(value => { if (live) setSnapshot(value) }).catch(e => { if (live) setError(toolError(e)) })
    return () => { live = false; unsubscribe() }
  }, [active])
  useEffect(() => () => { void window.dustdesk.toolbox.releaseAssets(currentAssets.current.map(asset => asset.id)).catch(() => {}) }, [])
  const perform = async (key: string, action: () => Promise<unknown>) => {
    if (operations.current.has(key)) return
    operations.current.add(key); setPending(new Set(operations.current)); setError('')
    try { await action() } catch (e) { setError(toolError(e)) }
    finally { operations.current.delete(key); setPending(new Set(operations.current)) }
  }
  const pick = (folder: boolean) => perform('form', async () => {
    const imported = await window.dustdesk.toolbox.pick(folder ? 'folder' : 'files')
    setAssets(current => [...current, ...imported])
  })
  const control = (id: string, action: TaskAction) => perform(id, async () => {
    if (action === 'clear') {
      const task = snapshot.tasks.find(value => value.id === id)
      if (!task) return
      const message = taskStates[task.status].finished
        ? task.text !== undefined ? '移除此文本任务记录？请先复制或保存需要保留的文本。' : '移除此任务记录？已接收的文件会保留。'
        : '删除此未完成任务并清理未完成的临时文件？已完成的文件会保留，此任务将无法继续。'
      if (!await confirm(message)) return
    }
    await window.dustdesk.toolbox.lanControl(id, action)
  })
  const clearFinished = () => perform('clear-finished', async () => {
    if (!await confirm(`清理 ${finishedTasks.length} 条已结束任务记录？已接收的文件会保留，请先复制或保存需要保留的文本。`)) return
    for (const task of finishedTasks) {
      if (!operations.current.has(task.id)) await window.dustdesk.toolbox.lanControl(task.id, 'clear')
    }
  })
  const send = () => perform('form', () => window.dustdesk.toolbox.lanSend(device, mode === 'files' ? assets.map(asset => asset.id) : [], mode === 'text' ? text : undefined))

  return <div className="toolbox-page" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => {
    event.preventDefault()
    if (!active || busy) return
    const paths = window.dustdesk.getDroppedPaths([...event.dataTransfer.files])
    if (paths.length) void perform('form', async () => {
      const imported = await window.dustdesk.toolbox.registerPaths(paths, 'transfer')
      setAssets(current => [...current, ...imported]); setMode('files')
    })
  }}>
    <div className="lan-tool-layout">
      <Panel>
        <div className="toolbox-heading"><strong>附近设备</strong><button className={snapshot.enabled ? 'secondary-button' : 'primary-button'} disabled={busy} onClick={() => void perform('form', async () => setSnapshot(await window.dustdesk.toolbox.lanEnable(!snapshot.enabled)))}><Radio size={15} />{snapshot.enabled ? '关闭局域网传输' : '开启局域网传输'}</button></div>
        <div className="lan-device-list">
          {snapshot.devices.map(peer => <button className={`lan-device ${device === peer.id ? 'selected' : ''}`} key={peer.id} onClick={() => setDevice(peer.id)}><Monitor size={21} /><span><strong>{peer.name}</strong><small>{peer.address}:{peer.port}</small></span>{device === peer.id && <span className="status-dot" />}</button>)}
          {!snapshot.devices.length && <div className="toolbox-empty"><Monitor size={28} /><p>{snapshot.enabled ? '等待发现其他电脑' : '开启后发现同一局域网的电脑'}</p><small>对方也需要开启 DustDesk 局域网传输</small></div>}
        </div>
        <div className="toolbox-fieldset"><h3>手动连接</h3><div className="lan-connect">
          <input aria-label="设备 IPv4 地址" placeholder="192.168.1.10" value={address} onChange={event => setAddress(event.target.value)} />
          <NumberInput variant="input" aria-label="设备端口" placeholder="端口" min="1" max="65535" value={port} onValueChange={setPort} />
          <button className="secondary-button" disabled={!snapshot.enabled || busy || !address.trim() || !port} onClick={() => void perform('form', async () => { const peer = await window.dustdesk.toolbox.lanConnect(address.trim(), Number(port)); setDevice(peer.id) })}><Plus size={14} />连接</button>
        </div><p className="muted">首次连接需在两台电脑核对配对码。</p>{snapshot.enabled && <div className="lan-addresses"><small>本机连接信息</small>{snapshot.addresses.map(ip => <code key={ip}>{ip}:{snapshot.port}</code>)}{!snapshot.addresses.length && <small>未发现局域网 IPv4 网卡</small>}</div>}</div>
      </Panel>
      <Panel>
        <div className="toolbox-heading"><strong>发送内容</strong><div className="segmented"><button className={mode === 'files' ? 'selected' : ''} onClick={() => setMode('files')}>文件 / 文件夹</button><button className={mode === 'text' ? 'selected' : ''} onClick={() => setMode('text')}>文本</button></div></div>
        <div className="lan-send-body">{mode === 'files' ? <>
          <div className="toolbox-options"><button className="secondary-button" disabled={busy} onClick={() => void pick(false)}><FilePlus size={15} />添加文件</button><button className="secondary-button" disabled={busy} onClick={() => void pick(true)}><FolderOpen size={15} />添加文件夹</button></div>
          <div className="lan-pending">{assets.map(asset => <div key={asset.id}><FolderOpen size={16} /><span>{asset.name}</span><small className="muted">{asset.size ? fileSize(asset.size) : '准备时计算大小'}</small><button className="icon-button" disabled={busy} aria-label={`移除 ${asset.name}`} onClick={() => {
            setAssets(current => current.filter(value => value.id !== asset.id))
            void window.dustdesk.toolbox.releaseAssets([asset.id]).catch(e => setError(toolError(e)))
          }}><X size={14} /></button></div>)}{!assets.length && <div className="toolbox-empty"><Send size={28} /><p>添加或拖入要发送的内容</p><small>原文件保留在原位置</small></div>}</div>
        </> : <textarea className="lan-text" aria-label="发送文本" value={text} onChange={event => setText(event.target.value)} placeholder="输入要发送的文本，最多 10 MiB" disabled={busy} />}</div>
        <div className="toolbox-footer"><span className="muted">{selectedDevice?.name ?? '请先选择接收设备'}</span><button className="primary-button" disabled={busy || sending || !snapshot.enabled || !selectedDevice || (mode === 'files' ? !assets.length : !text)} onClick={() => void send()}><Send size={14} />{busy ? '正在处理…' : sending ? '传输中' : '发送'}</button></div>
      </Panel>
    </div>
    {(error || snapshot.error) && <div className="toolbox-error" role="alert">{error || snapshot.error}</div>}
    <Panel>
      <div className="toolbox-heading"><strong>传输任务</strong><button className="mini-button" disabled={!finishedTasks.length || pending.has('clear-finished')} onClick={() => void clearFinished()}>清理已结束记录</button></div>
      <div className="lan-tasks">{snapshot.tasks.map(task => {
        const state = taskStates[task.status]
        return <div className="lan-task" key={task.id}>
          <div className="lan-task-title"><strong>{task.name}</strong><span className={`lan-status status-${task.status}`}>{state.label}</span></div>
          <div className="lan-task-meta"><span>{task.direction === 'send' ? '发送至' : '接收自'} {task.device}</span><span>{task.text !== undefined ? '文本' : `${fileSize(task.done)} / ${fileSize(task.total)}${task.speed ? ' · ' + fileSize(task.speed) + '/s' : ''}`}</span></div>
          {task.text === undefined && <Progress max={Math.max(1, task.total)} value={task.status === 'completed' ? Math.max(1, task.total) : task.done} />}
          {task.error && <p className="toolbox-error">{task.error}</p>}
          {task.text !== undefined && <pre className="lan-received-text">{task.text.slice(0, 5000)}{task.text.length > 5000 ? '\n…（复制或保存完整内容）' : ''}</pre>}
          <div className="toolbox-actions">{state.actions.map(action => action === 'resume' && task.direction === 'receive'
            ? <small key={action} className="muted">在发送电脑点击继续</small>
            : <button key={action} className="mini-button" disabled={pending.has(task.id) || pending.has('clear-finished') || (action === 'resume' && !snapshot.enabled)} onClick={() => void control(task.id, action)}>{action === 'clear' ? state.finished ? '移除记录' : '删除未完成任务' : actionLabels[action]}</button>)}
            {task.directory && <button className="mini-button" onClick={() => void window.dustdesk.openPath(task.directory!)}><FolderOpen size={13} />打开目录</button>}
            {task.text !== undefined && <><button className="mini-button" onClick={() => { void window.dustdesk.toolbox.copyText(task.text!).then(() => toast.success('文本已复制')).catch(e => toast.error(toolError(e))) }}><Copy size={13} />复制</button><button className="mini-button" onClick={() => { void window.dustdesk.toolbox.exportText(task.text!).catch(e => toast.error(toolError(e))) }}><Download size={13} />保存</button></>}
          </div>
        </div>
      })}{!snapshot.tasks.length && <div className="toolbox-empty"><p>暂无传输任务</p><small>文件任务支持关闭应用后重新恢复</small></div>}</div>
    </Panel>
    {confirmationDialog}
  </div>
}
