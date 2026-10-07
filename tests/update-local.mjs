import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(packageJson.build.productName, 'DustDesk')
assert.equal(packageJson.build.win.target.includes('nsis'), true)
assert.equal(packageJson.build.win.target.includes('portable'), true)
assert.deepEqual(packageJson.build.publish, { provider: 'github', owner: 'Xu-qingsong', repo: 'DustDesk-Next' })
assert.equal(packageJson.bugs.url, 'https://github.com/Xu-qingsong/DustDesk-Next/issues')
console.log('Update/package contract passed')
