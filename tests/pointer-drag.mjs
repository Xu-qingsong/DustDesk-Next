import assert from 'node:assert/strict'

export async function keyboardPickup(handle) {
  await handle.focus()
  await handle.press('Space')
  await handle.page().waitForFunction(element => element.getAttribute('aria-pressed') === 'true', await handle.elementHandle())
  await handle.page().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

export async function keyboardMove(handle, direction) {
  await handle.press(direction)
  await handle.page().evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

export async function pointerDrag(source,target) {
  const page=source.page()
  await source.scrollIntoViewIfNeeded()
  const initial=await source.boundingBox()
  assert.ok(initial,'Drag source must have a visible bounding box')
  const start={x:initial.x+initial.width/2,y:initial.y+initial.height/2}
  await page.mouse.move(start.x,start.y)
  await page.mouse.down()
  try {
    await page.mouse.move(start.x+8,start.y+8,{steps:4})
    await target.scrollIntoViewIfNeeded()
    const destination=await target.boundingBox()
    assert.ok(destination,'Drop target must have a visible bounding box')
    await page.mouse.move(destination.x+destination.width/2,destination.y+destination.height/2,{steps:16})
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  } finally { await page.mouse.up() }
}
