import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source=await readFile('src/shared/fileDrop.ts','utf8')
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
const {acceptsFileDrop}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))
const bounds={left:10,top:20,right:110,bottom:120,width:100,height:100}
function elements({inside=true,blocked=false,rect=bounds}={}) {const hit={closest:()=>blocked?{}:null};return {hit,element:{contains:target=>inside&&target===hit,getBoundingClientRect:()=>rect}}}
test('file drop routing requires the actual visible target and logical hit position',()=>{
  const {element,hit}=elements()
  assert.equal(acceptsFileDrop(element,hit,{x:50,y:60}),true)
  for(const position of [{x:9,y:60},{x:110,y:60},{x:50,y:120},{x:-1,y:10},{x:NaN,y:40},{x:10,y:Infinity}])assert.equal(acceptsFileDrop(element,hit,position),false)
  assert.equal(acceptsFileDrop(null,hit,{x:50,y:60}),false)
  assert.equal(acceptsFileDrop(element,null,{x:50,y:60}),false)
})
test('file drop routing rejects occluded hidden editable and modal surfaces',()=>{
  for(const options of [{inside:false},{blocked:true},{rect:{...bounds,width:0}},{rect:{...bounds,height:0}}]){const {element,hit}=elements(options);assert.equal(acceptsFileDrop(element,hit,{x:50,y:60}),false)}
})
test('native file-drop commands never accept renderer paths or a global event subscriber',async()=>{
  const permissions=await readFile('src-tauri/permissions/file-drop.toml','utf8')
  assert.deepEqual(JSON.parse(permissions.match(/commands.allow = (\[[^\n]+\])/)[1]),['file_drop_attach','file_drop_detach'])
  const implementation=await readFile('src-tauri/src/file_drop.rs','utf8')
  assert.doesNotMatch(implementation,/emit_to|Emitter|pub async fn file_drop[^\n]*paths/)
  assert.match(implementation,/Window|WebviewWindow/)
})
