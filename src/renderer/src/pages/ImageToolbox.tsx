import { ColorPicker } from "../components/ui/ColorPicker"
import { Slider, NumberInput, Checkbox } from "../components/ui/FormControls"
import { Select } from '../components/ui/Select'
import { useConfirmDialog } from '../components/ui/ConfirmDialog'
import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Download, Play, X, ClipboardPaste, FolderOpen } from 'lucide-react'
import { Panel } from '../components/common'
import { defaultImageOptions, toolError } from '../../../shared/toolbox'
import type { ImageOptions, ToolAsset } from '../../../shared/toolbox'
import { JobWorker } from '../toolbox/jobWorker'
import { ImagePreviewSession, type ImageResult } from '../toolbox/imagePreview'
import { fileSize } from '../toolbox/format'
import { portraitPresets, centeredCrop } from '../../../shared/imagePresets'
import { CropPreview } from '../toolbox/CropPreview'

interface Item { asset: ToolAsset; status: 'waiting' | 'processing' | 'ready' | 'failed' | 'exported'; thumbnail?: string; error?: string; original?: { width: number; height: number; format: ImageResult['originalFormat'] }; result?: { width: number; height: number; size: number; retainedOriginal: boolean } }
function sizeChange(item: Item) {
  if (!item.result) return ''
  if (item.result.retainedOriginal) return '保留原图（重新编码未变小）'
  const difference = item.result.size - item.asset.size
  if (!difference) return '大小不变'
  const percent = (Math.abs(difference) / item.asset.size * 100).toFixed(1)
  return `${difference < 0 ? '减小' : '增大'} ${percent}%`
}
interface ImageTask { cancelled: boolean }
export function ImageToolbox({ active }: { active: boolean }) {
  const [items, setItems] = useState<Item[]>([]), [options, setOptions] = useState<ImageOptions>({ ...defaultImageOptions }), [selected, setSelected] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [category, setCategory] = useState<'general' | 'avatar' | 'portrait'>('general')
  const categorySettings = useRef<Record<string, ImageOptions>>({ general: {...defaultImageOptions}, avatar: {...defaultImageOptions, category:'avatar', format:'png', avatarShape:'square', resize:'dimensions',fit:'cover',upscale:true,width:512,height:512}, portrait: {...defaultImageOptions,category:'portrait',format:'jpeg',resize:'dimensions',fit:'cover',upscale:true,preset:'one',width:295,height:413,dpi:300} })
  const [crops, setCrops] = useState<Record<string, NonNullable<ImageOptions['crop']>>>({})
  const [previewUpdating, setPreviewUpdating] = useState(false), [previewError,setPreviewError] = useState('')
  const previewSession = useRef<ImagePreviewSession | null>(null), previewSequence=useRef(0)
  if (!previewSession.current) previewSession.current = new ImagePreviewSession()
  const configFor = (id:string, config=options):ImageOptions => ({...config,category,crop:crops[`${category}:${id}`]||centeredCrop,format:category==='avatar'&&config.avatarShape==='circle'?'png':config.format})
  const switchCategory=(next:typeof category)=>{categorySettings.current[category]={...options};setCategory(next);setOptions({...categorySettings.current[next]!});setItems(current=>current.map(item=>({...item,status:'waiting',result:undefined})));setError('');setProgress('')}
  const changeCrop=(crop:NonNullable<ImageOptions['crop']>)=>{setCrops(current=>({...current,[`${category}:${selected}`]:crop}));update(selected,{result:undefined,status:'waiting'})}
  const { confirm, confirmationDialog } = useConfirmDialog()
  const [operation, setOperation] = useState<'importing' | 'processing' | null>(null), [error, setError] = useState(''), [progress, setProgress] = useState('')
  const [preview, setPreview] = useState<{ id: string; original: string; output: string; ownedOriginal?: boolean }>(), [watermarkName, setWatermarkName] = useState(''), [exportPath, setExportPath] = useState<{ path: string; directory: string }>()
  const worker = useRef<JobWorker | null>(null), taskRef = useRef<ImageTask | null>(null)
  const assets = useRef(new Set<string>()), urls = useRef(new Set<string>())
  const busy = operation === 'processing', importing = operation === 'importing'
  if (!worker.current) worker.current = new JobWorker(() => new Worker(new URL('../toolbox/image.worker.ts', import.meta.url), { type: 'module' }))
  const update = (id: string, value: Partial<Item>) => setItems(current => current.map(item => item.asset.id === id ? { ...item, ...value } : item))
  function change<K extends keyof ImageOptions>(key: K, value: ImageOptions[K]) {
    if (Object.is(options[key], value)) return
    setOptions(current => ({ ...current, [key]: value }))
    setItems(current => current.map(item => ({ ...item, status: 'waiting', result: undefined, error: undefined })))
    setError(''); setProgress('')
  }
  useEffect(() => { return () => { if (preview) { if (preview.ownedOriginal) URL.revokeObjectURL(preview.original); URL.revokeObjectURL(preview.output) } } }, [preview])
  useEffect(() => () => {
    taskRef.current = null; worker.current?.cancel(); previewSession.current?.dispose(); previewSequence.current++
    urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current.clear()
    void window.dustdesk.toolbox.releaseAssets([...assets.current]).catch(() => {})
    assets.current.clear()
  }, [])
  useEffect(()=>{
    const sequence=++previewSequence.current
    previewSession.current?.invalidate()
    if (!selected) { previewSession.current?.dispose(); setPreview(undefined); setPreviewUpdating(false); return }
    if(!active||operation){previewSession.current?.cancel();setPreviewUpdating(false);return}
    let cancelled=false
    setPreviewUpdating(true);setPreviewError('')
    const timer=setTimeout(()=>{void (async()=>{
      const { result, original } = await previewSession.current!.render(selected, configFor(selected))
      if(cancelled||sequence!==previewSequence.current)return
      setPreview({ id: selected, original, output: URL.createObjectURL(new Blob([new Uint8Array(result.bytes)])) })
      setItems(current=>current.map(item=>item.asset.id===selected?{...item,original:{width:result.originalWidth,height:result.originalHeight,format:result.originalFormat},result:{width:result.width,height:result.height,size:result.bytes.length,retainedOriginal:result.retainedOriginal},status:item.status==='exported'||item.status==='failed'?item.status:'ready',error:item.status==='failed'?item.error:undefined}:item))
    })().catch(e=>{if(!cancelled&&sequence===previewSequence.current)setPreviewError(toolError(e))}).finally(()=>{if(!cancelled&&sequence===previewSequence.current)setPreviewUpdating(false)})},200)
    return()=>{cancelled=true;clearTimeout(timer);previewSession.current?.invalidate()}
  },[active,selected,options,crops,category,operation])
  const isCurrent = (task: ImageTask) => taskRef.current === task && !task.cancelled
  const checkTask = (task: ImageTask) => { if (!isCurrent(task)) throw Error('任务已取消') }
  const runOperation = async (kind: 'importing' | 'processing', run: (task: ImageTask) => Promise<void>) => {
    if (taskRef.current) return
    const task: ImageTask = { cancelled: false }
    if (kind === 'processing') {
      // Explicit processing uses fresh source bytes. Its following automatic preview must do the same.
      ++previewSequence.current; previewSession.current?.dispose(); setPreview(undefined)
    }
    taskRef.current = task; setOperation(kind); setError('')
    try { await run(task) }
    catch (e) { if (isCurrent(task)) setError(toolError(e)) }
    finally {
      // Keep the synchronous lock until pending IPC and batch cleanup settle.
      if (taskRef.current === task) {
        setItems(current => current.map(item => item.status === 'processing' ? { ...item, status: 'waiting' } : item))
        taskRef.current = null; setOperation(null)
      }
    }
  }
  const release = async (ids: string[]) => {
    await window.dustdesk.toolbox.releaseAssets(ids)
    ids.forEach(id => assets.current.delete(id))
  }
  const adopt = async (task: ImageTask, imported: ToolAsset[]) => {
    if (!isCurrent(task)) { await release(imported.map(asset => asset.id)); return false }
    imported.forEach(asset => assets.current.add(asset.id)); return true
  }
  const renderImage = async (task: ImageTask, id: string, config: ImageOptions, mark?: Uint8Array, withPreview = false) => {
    checkTask(task)
    const bytes = await window.dustdesk.toolbox.readAsset(id)
    checkTask(task)
    const original = withPreview ? new Uint8Array(bytes) : undefined
    // Transfer a copy of the shared watermark so the next image can reuse it.
    const watermark = mark ? new Uint8Array(mark) : undefined
    const result = await worker.current!.run<ImageResult>({ bytes, options: config, watermark }, 60000, [bytes.buffer, ...(watermark ? [watermark.buffer] : [])])
    checkTask(task)
    return { result, original }
  }
  const addImages = async (task: ImageTask, imported: ToolAsset[]) => {
    if (!await adopt(task, imported) || !isCurrent(task)) return
    setItems(current => [...current, ...imported.map(asset => ({ asset, status: 'waiting' as const }))])
    if (imported[0]) { setSelected(imported[0].id); setPreview(undefined) }
    for (const asset of imported) {
      try {
        const { result } = await renderImage(task, asset.id, { ...defaultImageOptions, format: 'png', resize: 'dimensions', width: 72, height: 72 })
        const thumbnail = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)])); urls.current.add(thumbnail)
        update(asset.id, { thumbnail, original: { width: result.originalWidth, height: result.originalHeight, format: result.originalFormat } })
      } catch (e) { if (!isCurrent(task)) return; update(asset.id, { status: 'failed', error: toolError(e) }) }
    }
  }
  const importFiles = (files: File[]) => runOperation('importing', async task => {
    const paths = window.dustdesk.getDroppedPaths(files)
    if (paths.length === files.length) await addImages(task, await window.dustdesk.toolbox.registerPaths(paths, 'image'))
    else for (const file of files) {
      checkTask(task)
      const [filePath] = window.dustdesk.getDroppedPaths([file])
      if (filePath) await addImages(task, await window.dustdesk.toolbox.registerPaths([filePath], 'image'))
      else {
        const bytes = new Uint8Array(await file.arrayBuffer()); checkTask(task)
        await addImages(task, [await window.dustdesk.toolbox.importImage(bytes, file.name)])
      }
    }
  })
  useEffect(() => {
    if (!active) return
    const paste = (event: ClipboardEvent) => { if (taskRef.current || (event.target instanceof Element && event.target.closest('input,textarea'))) return; const files = [...(event.clipboardData?.items ?? [])].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter((f): f is File => !!f); if (files.length) { event.preventDefault(); void importFiles(files) } }
    document.addEventListener('paste', paste); return () => document.removeEventListener('paste', paste)
  }, [active])
  const pick = (watermark = false) => runOperation('importing', async task => {
    const imported = await window.dustdesk.toolbox.pick('image')
    if (!watermark) { await addImages(task, imported); return }
    if (!await adopt(task, imported) || !isCurrent(task)) return
    if (imported[0]) {
      const previous = options.watermarkAsset
      change('watermarkAsset', imported[0].id); setWatermarkName(imported[0].name)
      await release([...imported.slice(1).map(asset => asset.id), ...(previous ? [previous] : [])])
    }
  })
  const pasteImage = () => runOperation('importing', async task => {
    const clip = await window.dustdesk.readClipboard(); checkTask(task)
    if (!clip.imagePngBase64) throw Error('剪贴板没有图片')
    const bytes = Uint8Array.from(atob(clip.imagePngBase64), c => c.charCodeAt(0))
    await addImages(task, [await window.dustdesk.toolbox.importImage(bytes, '剪贴板.png')])
  })
  const process = ({ exporting = false, onlyFailed = false, id }: { exporting?: boolean; onlyFailed?: boolean; id?: string } = {}) => runOperation('processing', async task => {
    const list = items.filter(item => (!id || item.asset.id === id) && (!onlyFailed || item.status === 'failed')), config = configFor(selected)
    if (!list.length) return
    const previewId = id ?? selected
    if (id) setSelected(id)
    let batch: { id?: string } = {}
    const exportedIds: string[] = []
    let succeeded = 0, failed = 0, completedProcessing = false
    try {
      if (exporting) {
        batch = await window.dustdesk.toolbox.beginImageExport(list.map(item => item.asset.id), config.format); checkTask(task)
        if (!batch.id) return
      }
      const mark = config.watermark === 'image' && config.watermarkAsset ? await window.dustdesk.toolbox.readAsset(config.watermarkAsset) : undefined
      checkTask(task)
      for (let index = 0; index < list.length; index++) {
        if (!isCurrent(task)) break
        const item = list[index]!; setProgress(`${exporting ? '导出' : '处理'} ${index + 1} / ${list.length}`); update(item.asset.id, { status: 'processing', error: undefined, result: undefined })
        try {
          const { result, original } = await renderImage(task, item.asset.id, configFor(item.asset.id,config), mark, item.asset.id === previewId)
          if (exporting) {
            const stem = item.asset.name.replace(/\.[^.]+$/, '')
            await window.dustdesk.toolbox.exportImage(batch.id!, `${stem}-处理后.${result.format === 'jpeg' ? 'jpg' : result.format}`, result.bytes)
            exportedIds.push(item.asset.id)
            checkTask(task)
          }
          update(item.asset.id, { status: !exporting && id && item.status === 'exported' ? 'exported' : 'ready', original: { width: result.originalWidth, height: result.originalHeight, format: result.originalFormat }, result: { width: result.width, height: result.height, size: result.bytes.length, retainedOriginal: result.retainedOriginal } }); succeeded++
          if (original) setPreview({ id: item.asset.id, ownedOriginal: true, original: URL.createObjectURL(new Blob([original])), output: URL.createObjectURL(new Blob([new Uint8Array(result.bytes)])) })
        } catch (e) { if (!isCurrent(task)) break; update(item.asset.id, { status: 'failed', error: toolError(e) }); failed++; if (id) setError(toolError(e)) }
      }
      completedProcessing = true
      if (!exporting && isCurrent(task)) setProgress(`处理完成：${succeeded} 成功${failed ? `，${failed} 失败，可重试` : ''}`)
    } finally {
      if (batch.id) {
        try {
          if (isCurrent(task)) setProgress(list.length > 1 ? '正在保存压缩包…' : '正在保存图片…')
          const output = await window.dustdesk.toolbox.endImageExport(batch.id)
          if (output.path && output.directory) setExportPath({ path: output.path, directory: output.directory })
          for (const asset of exportedIds) update(asset, { status: 'exported' })
          if (isCurrent(task)) setProgress(completedProcessing ? `导出完成：${succeeded} 成功${failed ? `，${failed} 失败，可重试` : ''}` : '')
        } catch (e) {
          for (const asset of exportedIds) update(asset, { status: 'failed', error: toolError(e) })
          if (taskRef.current === task) { setError(toolError(e)); setProgress('导出失败，请重试') }
        }
      }
    }
  })
  const cancel = () => { if (taskRef.current) taskRef.current.cancelled = true; worker.current?.cancel(); setProgress('已取消，已处理成功的图片保留') }
  const removeItems = (ids: Set<string>) => {
    if (taskRef.current) return
    const removed = items.filter(item => ids.has(item.asset.id))
    setItems(current => current.filter(item => !ids.has(item.asset.id)))
    setChecked(current => new Set([...current].filter(id => !ids.has(id))))
    setCrops(current=>Object.fromEntries(Object.entries(current).filter(([key])=>![...ids].some(id=>key.endsWith(':'+id)))))
    for (const item of removed) if (item.thumbnail) { URL.revokeObjectURL(item.thumbnail); urls.current.delete(item.thumbnail) }
    void release(removed.map(item => item.asset.id)).catch(e => setError(toolError(e)))
    if (ids.has(selected)) { setSelected(''); setPreview(undefined) }
    setProgress('')
  }
  const remove = (item: Item) => removeItems(new Set([item.asset.id]))
  const removeChecked = async () => {
    if (taskRef.current || !checked.size) return
    const ids = new Set(checked)
    if (await confirm(`从图片工具箱删除选中的 ${ids.size} 张图片？原始文件和已导出的文件会保留。`)) removeItems(ids)
  }
  const number = (key: 'percent' | 'width' | 'height' | 'margin' | 'watermarkSize', value: string) => change(key, Number(value))
  const current = items.find(i => i.asset.id === selected)
  const showQuality = options.format === 'jpeg' || options.format === 'webp'
    || (options.format === 'original' && (!items.length || items.some(item => item.original?.format !== 'png')))
  const showJpegBackground = options.format === 'jpeg'
    || (options.format === 'original' && (!items.length || items.some(item => !item.original || item.original.format === 'jpeg')))
  return <div className="toolbox-page" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => { event.preventDefault(); if (!busy && !importing) void importFiles([...event.dataTransfer.files]) }}><div className="image-tool-topbar">
    <div className="toolbox-tabs" role="tablist" aria-label="图片工具分类">{([['general','通用处理'],['avatar','头像裁剪'],['portrait','证件照尺寸']] as const).map(([value,label])=><button key={value} role="tab" aria-selected={category===value} className={category===value?'primary-button':'secondary-button'} disabled={busy||importing} onClick={()=>switchCategory(value)}>{label}</button>)}</div><div className="toolbox-actions"><button className="secondary-button" disabled={busy || importing} onClick={() => void pasteImage()}><ClipboardPaste size={15} />粘贴图片</button><button className="primary-button" disabled={busy || importing} onClick={() => void pick()}><ImagePlus size={15} />导入图片</button></div></div>
    <div className="image-tool-layout"><Panel><fieldset className="toolbox-fieldset" disabled={busy || importing}>{category!=='general'&&<><h3>{category==='avatar'?'头像快捷裁剪':'证件照快捷尺寸'}</h3>{category==='avatar'?<div className="toolbox-option-grid"><label>形状<Select aria-label="头像形状" value={options.avatarShape||'square'} onValueChange={value=>change('avatarShape',value as 'square'|'circle')}><option value="square">方形</option><option value="circle">圆形（透明 PNG）</option></Select></label><label>尺寸<Select aria-label="头像尺寸" value={options.width} onValueChange={value=>{setOptions(current=>({...current,width:+value,height:+value}));setItems(current=>current.map(item=>({...item,result:undefined,status:'waiting'})))}}>{[128,256,512,1024].map(size=><option key={size} value={size}>{size}×{size} px</option>)}</Select></label></div>:<><label>证件照规格<Select aria-label="证件照规格" value={options.preset||'one'} onValueChange={value=>{const preset=portraitPresets.find(item=>item.id===value)!;setOptions(current=>({...current,preset:value,width:preset.width,height:preset.height}));setItems(current=>current.map(item=>({...item,result:undefined,status:'waiting'})))}}>{portraitPresets.map(preset=><option key={preset.id} value={preset.id}>{preset.name} · {preset.mmWidth}×{preset.mmHeight} mm</option>)}</Select></label><p className="muted">{options.width}×{options.height} px · 300 DPI</p></>}<p className="muted">拖动预览调整构图，方向键移动，加减键缩放。快捷尺寸允许放大小图，可能降低清晰度。</p><label>缩放 · {(crops[`${category}:${selected}`]?.zoom||1).toFixed(2)}×<Slider aria-label="裁剪缩放" min="1" max="8" step="0.01" value={crops[`${category}:${selected}`]?.zoom||1} disabled={!selected||busy||importing} onChange={event=>changeCrop({...crops[`${category}:${selected}`]||centeredCrop,zoom:+event.target.value})}/></label><button className="secondary-button" disabled={!selected||busy||importing} onClick={()=>changeCrop({...centeredCrop})}>重置构图</button></>}
<h3>输出设置</h3><div className="toolbox-option-grid"><label>格式<Select aria-label="格式" disabled={busy || importing || (category === 'avatar' && options.avatarShape === 'circle')} value={category === 'avatar' && options.avatarShape === 'circle' ? 'png' : options.format} onValueChange={value => change('format', value as ImageOptions['format'])}><option value="original">保持原格式</option><option value="png">PNG（无损）</option><option value="jpeg">JPG</option><option value="webp">WebP</option></Select></label>{showQuality && <label>有损质量 · {options.quality}<Slider min="1" max="100" value={options.quality} onChange={e => change('quality', +e.target.value)} aria-label="有损质量" disabled={busy || importing} /></label>}{category=== 'general' && <label>尺寸调整<Select aria-label="尺寸调整" disabled={busy || importing} value={options.resize} onValueChange={value => change('resize', value as ImageOptions['resize'])}><option value="none">保持原尺寸</option><option value="percent">按比例</option><option value="dimensions">指定尺寸</option></Select></label>}{showJpegBackground && <label>JPG 背景<ColorPicker value={options.background} onValueChange={nextValue => change('background', nextValue)} aria-label="JPG 背景" disabled={busy || importing} /></label>}
    {category === 'general' && options.resize === 'percent' && <label>比例 %<NumberInput variant="input" min="1" max="1000" value={options.percent} onValueChange={nextValue => number('percent', nextValue)} aria-label="比例 %" disabled={busy || importing} /></label>}
    {category === 'general' && options.resize === 'dimensions' && <><label>宽度 px<NumberInput variant="input" min="1" value={options.width} onValueChange={nextValue => number('width', nextValue)} aria-label="宽度 px" disabled={busy || importing} /></label><label>高度 px<NumberInput variant="input" min="1" value={options.height} onValueChange={nextValue => number('height', nextValue)} aria-label="高度 px" disabled={busy || importing} /></label><label className="toolbox-span">适配方式<Select aria-label="适配方式" disabled={busy || importing} value={options.fit} onValueChange={value => change('fit', value as ImageOptions['fit'])}><option value="contain">等比适应</option><option value="cover">居中裁切</option><option value="stretch">拉伸</option></Select></label></>}
    {category === 'general' && options.resize !== 'none' && <label className="toolbox-check toolbox-span"><Checkbox checked={options.upscale} onChange={e => change('upscale', e.target.checked)} disabled={busy || importing} />允许放大小图</label>}</div><h3>水印</h3><div className="toolbox-option-grid"><label className="toolbox-span">类型<Select aria-label="类型" disabled={busy || importing} value={options.watermark} onValueChange={value => change('watermark', value as ImageOptions['watermark'])}><option value="none">不添加水印</option><option value="text">文字水印</option><option value="image">图片水印</option></Select></label>
    {options.watermark === 'text' && <><label className="toolbox-span">水印文字<textarea value={options.text} onChange={e => change('text', e.target.value)} /></label><label>文字颜色<ColorPicker value={options.color} onValueChange={nextValue => change('color', nextValue)} aria-label="文字颜色" disabled={busy || importing} /></label></>}
    {options.watermark === 'image' && <button className="secondary-button toolbox-span" onClick={() => void pick(true)}>{watermarkName || '选择水印图片'}</button>}
    {options.watermark !== 'none' && <><label>位置<Select aria-label="位置" disabled={busy || importing} value={options.position} onValueChange={value => change('position', +value)}>{['左上','上中','右上','左中','居中','右中','左下','下中','右下'].map((label, index) => <option key={label} value={index}>{label}</option>)}</Select></label><label>边距 px<NumberInput variant="input" min="0" value={options.margin} onValueChange={nextValue => number('margin', nextValue)} aria-label="边距 px" disabled={busy || importing} /></label><label>{options.watermark === 'text' ? '字号' : '图片宽度'} px<NumberInput variant="input" min="1" value={options.watermarkSize} onValueChange={nextValue => number('watermarkSize', nextValue)} aria-label="水印大小" disabled={busy || importing} /></label><label>不透明度 · {options.opacity}%<Slider min="0" max="100" value={options.opacity} onChange={e => change('opacity', +e.target.value)} aria-label="不透明度 ·%" disabled={busy || importing} /></label></>}
    </div><p className="muted">PNG 无损编码不受质量滑块影响。同格式、尺寸不变且无水印时，重新编码未变小会保留原图。需要更小文件可选择 WebP / JPG 或缩小尺寸；转换、缩放及水印结果仍可能变大。单图最多 100 MiB / 6400 万像素。</p></fieldset></Panel>
    <Panel><div className="toolbox-heading"><strong>{items.length ? `${items.length} 张图片` : '拖入图片开始'}</strong><span className="muted">{importing ? '正在导入…' : progress}</span></div>{items.length > 0 && <div className="toolbox-heading image-tool-selection"><label className="toolbox-check"><Checkbox aria-label="全选图片" checked={checked.size === items.length} aria-checked={checked.size > 0 && checked.size < items.length ? 'mixed' : checked.size === items.length} disabled={busy || importing} onChange={event => setChecked(event.target.checked ? new Set(items.map(item => item.asset.id)) : new Set())} />全选</label><span className="muted">已选 {checked.size} 张</span><button className="secondary-button" disabled={busy || importing || !checked.size} onClick={() => void removeChecked()}>删除选中</button></div>}<div className="image-tool-list">{items.map(item => <div key={item.asset.id} className={`image-tool-row ${selected === item.asset.id ? 'selected' : ''}`}><Checkbox aria-label={`选择 ${item.asset.name}`} checked={checked.has(item.asset.id)} disabled={busy || importing} onChange={event => { const isChecked = event.target.checked; setChecked(current => { const next = new Set(current); if (isChecked) next.add(item.asset.id); else next.delete(item.asset.id); return next }) }} /><button disabled={busy || importing} className="image-tool-name" onClick={() => { setSelected(item.asset.id); setPreviewError('') }}><>{item.thumbnail ? <img className="image-tool-thumb" src={item.thumbnail} alt="" /> : <ImagePlus size={17} />}</><span><strong>{item.asset.name}</strong><small>{fileSize(item.asset.size)}{item.result ? ` · ${item.original?.width}×${item.original?.height} → ${item.result.width}×${item.result.height} · ${fileSize(item.result.size)} · ${sizeChange(item)}` : ''}{item.error && <em>{item.error}</em>}</small></span></button><span className="muted">{{ waiting:'待处理',processing:'处理中',ready:'可导出',failed:'失败',exported:'已导出' }[item.status]}</span><button className="icon-button" aria-label={`移除 ${item.asset.name}`} disabled={busy || importing} onClick={() => remove(item)}><X size={14} /></button></div>)}{!items.length && <div className="toolbox-empty"><ImagePlus size={32} /><p>拖入或导入 PNG、JPG、WebP</p><small>也可按 Ctrl+V 粘贴图片</small></div>}</div>
    {preview?.id === selected && <div className="image-tool-preview"><figure><figcaption>原图 · {current?.original?.width}×{current?.original?.height}</figcaption><img src={preview.original} alt="原图预览" /></figure><figure><figcaption>{previewUpdating ? '更新中 · ' : '处理后 · '} {current?.result?.width}×{current?.result?.height}</figcaption>{category!=='general' && <CropPreview source={preview.original} options={configFor(selected)} disabled={busy||importing} onChange={changeCrop}/>}<img src={preview.output} alt="输出预览" className={category!=='general'?'image-encoded-preview':''} /></figure></div>}
    {previewError && <div className="toolbox-error" role="alert">{previewError}<button className="mini-button" onClick={()=>{previewSession.current?.dispose();setOptions(current=>({...current}))}}>重试预览</button></div>}{error && <div className="toolbox-error" role="alert">{error}</div>}<div className="toolbox-footer"><span className="muted">单张保存图片，多张打包 ZIP</span><div className="toolbox-actions">{busy ? <button className="secondary-button" onClick={cancel}>取消处理</button> : <><button className="secondary-button" disabled={!items.length || importing} onClick={() => void process()}><Play size={14} />批量预览</button>{items.some(i => i.status === 'failed') && <button className="secondary-button" onClick={() => void process({ exporting: true, onlyFailed: true })}>重试失败项</button>}<button className="primary-button" disabled={!items.length || importing} onClick={() => void process({ exporting: true })}><Download size={14} />导出全部</button></>}</div></div>{exportPath && <div className="toolbox-footer"><code className="toolbox-path">{exportPath.path}</code><button className="mini-button" onClick={() => void window.dustdesk.openPath(exportPath.directory)}><FolderOpen size={14} />打开目录</button></div>}
    </Panel></div>{confirmationDialog}</div>
}
