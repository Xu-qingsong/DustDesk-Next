import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(packageJson.build.productName, 'DustDesk')
assert.equal(packageJson.build.win.target.includes('nsis'), true)
assert.deepEqual(packageJson.build.win.target, ['nsis', 'zip'])
assert.equal(packageJson.build.win.artifactName, 'DustDesk-${version}-${arch}-green.${ext}')
assert.equal(packageJson.build.nsis.artifactName, 'DustDesk-${version}-${arch}.${ext}')
assert.deepEqual(packageJson.build.publish, { provider: 'github', owner: 'Xu-qingsong', repo: 'DustDesk-Next' })
assert.equal(packageJson.bugs.url, 'https://github.com/Xu-qingsong/DustDesk-Next/issues')
console.log('Update/package contract passed')
