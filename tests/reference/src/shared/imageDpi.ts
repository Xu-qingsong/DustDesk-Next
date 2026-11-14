// PNG pHYs and JPEG JFIF density preserve physical print dimensions.
export function withImageDpi(bytes: Uint8Array, format: string, dpi: number) {
  if (!dpi) return bytes
  if (format === 'png') {
    const density = Math.round(dpi / .0254), chunk = new Uint8Array(21), view = new DataView(chunk.buffer)
    view.setUint32(0, 9); chunk.set([112,72,89,115], 4); view.setUint32(8, density); view.setUint32(12, density); chunk[16] = 1
    let crc = 0xffffffff
    for (const byte of chunk.subarray(4,17)) { crc ^= byte; for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0) }
    view.setUint32(17,(crc^0xffffffff)>>>0)
    const chunks: Uint8Array[] = [bytes.subarray(0,8)]
    for(let at=8;at+12<=bytes.length;){const length=new DataView(bytes.buffer,bytes.byteOffset+at,4).getUint32(0)+12;const type=String.fromCharCode(...bytes.subarray(at+4,at+8));if(type!=='pHYs')chunks.push(bytes.subarray(at,at+length));if(type==='IHDR')chunks.push(chunk);at+=length}
    const result=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));let at=0;for(const c of chunks){result.set(c,at);at+=c.length}return result
  }
  if (format === 'jpeg') {
    const result = new Uint8Array(bytes)
    for(let at=2;at+18<=result.length;){if(result[at]!==255)break;const marker=result[at+1],length=(result[at+2]!<<8)|result[at+3]!;if(marker===224 && String.fromCharCode(...result.subarray(at+4,at+9))==='JFIF\0'){result[at+11]=1;const view=new DataView(result.buffer);view.setUint16(at+12,dpi);view.setUint16(at+14,dpi);return result}if(marker===218||length<2)break;at+=length+2}
    const jfif = Uint8Array.from([255,224,0,16,74,70,73,70,0,1,1,1,dpi>>8,dpi&255,dpi>>8,dpi&255,0,0])
    const output=new Uint8Array(bytes.length+jfif.length);output.set(bytes.subarray(0,2));output.set(jfif,2);output.set(bytes.subarray(2),2+jfif.length);return output
  }
  return bytes
}
