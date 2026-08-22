import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(packageJson.build.productName, 'DustDesk')
assert.equal(packageJson.build.win.target.includes('nsis'), true)
assert.equal(packageJson.build.win.target.includes('portable'), true)
console.log('Update/package contract passed')
