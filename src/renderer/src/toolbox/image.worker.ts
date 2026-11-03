import { inspectToolImage } from '../../../shared/imageTools'
import { withImageDpi } from '../../../shared/imageDpi'
import { drawToolImage } from './imageRender'
import type { ImageOptions } from '../../../shared/toolbox'
type Request = { bytes?: Uint8Array; options: ImageOptions; watermark?: Uint8Array; assetId?: string; watermarkId?: string }
type CachedImage = { id: string; bytes: Uint8Array; meta: ReturnType<typeof inspectToolImage>; image: ImageBitmap }
let cached: CachedImage | undefined, cachedMark: { id: string; image: ImageBitmap } | undefined
self.onmessage = async (event: MessageEvent<Request>) => {
  let image: ImageBitmap | undefined, watermark: ImageBitmap | undefined
  const { bytes: input, options, assetId, watermarkId } = event.data
  try {
    if (cached?.id !== assetId) { cached?.image.close(); cached = undefined }
    if (cachedMark?.id !== watermarkId) { cachedMark?.image.close(); cachedMark = undefined }
    let bytes: Uint8Array, meta: ReturnType<typeof inspectToolImage>
    if (assetId && cached?.id === assetId) { ({ bytes, meta, image } = cached) }
    else {
      if (!input) throw Error('图片预览缓存已失效，请重试')
      bytes = input; meta = inspectToolImage(bytes)
      image = await createImageBitmap(new Blob([new Uint8Array(bytes)]))
      if (assetId) cached = { id: assetId, bytes, meta, image }
    }
    if (watermarkId && cachedMark?.id === watermarkId) watermark = cachedMark.image
    else if (event.data.watermark) {
      inspectToolImage(event.data.watermark)
      watermark = await createImageBitmap(new Blob([new Uint8Array(event.data.watermark)]))
      if (watermarkId) cachedMark = { id: watermarkId, image: watermark }
    }
    const format = options.category === 'avatar' && options.avatarShape === 'circle' ? 'png' : options.format === 'original' ? meta.format : options.format
    const {canvas,layout} = drawToolImage(image, {...options,format},watermark)
    const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: Math.max(.01, Math.min(1, options.quality / 100)) })
    if(blob.type!==`image/${format}`)throw Error('当前环境不支持此输出格式')
    const encoded = withImageDpi(new Uint8Array(await blob.arrayBuffer()),format,options.category==='portrait'?300:options.dpi||0)
    const retainedOriginal = (!options.category || options.category==='general') && !options.dpi && format===meta.format && options.watermark==='none' && layout.width===image.width && layout.height===image.height && layout.drawWidth===image.width && layout.drawHeight===image.height && encoded.length>=bytes.length
    // Keep cached bytes attached for subsequent preview requests.
    const output=retainedOriginal?(assetId?new Uint8Array(bytes):bytes):encoded
    self.postMessage({result:{bytes:output,width:canvas.width,height:canvas.height,originalWidth:image.width,originalHeight:image.height,originalFormat:meta.format,format,retainedOriginal}},{transfer:[output.buffer]})
  } catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)})}
  finally{if(image!==cached?.image)image?.close();if(watermark!==cachedMark?.image)watermark?.close()}
}
