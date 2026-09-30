import assert from 'node:assert/strict'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

const first = await launchDustDesk()
try {
  await first.window.getByTitle('桌面小组件').click()
  await first.window.getByRole('button', { name: '显示任务小组件' }).click()
  assert.equal(await first.window.getByRole('button', { name: '隐藏任务小组件' }).getAttribute('aria-pressed'), 'true')
} finally {
  await closeDustDesk({ ...first, preserveTempRoot: true })
}

const second = await launchDustDesk({ tempRoot: first.tempRoot })
try {
  await second.window.waitForFunction(() => window.dustdesk.getWidgetVisibility(['todo']).then(result => result.todo === true))
  await second.window.waitForFunction(() => window.dustdesk.toggleWidgets('todo').then(result => result.visible === false))
  await second.window.waitForFunction(() => window.dustdesk.getWidgetVisibility(['todo']).then(result => result.todo === false))
} finally {
  await closeDustDesk({ ...second, preserveTempRoot: true })
}

const third = await launchDustDesk({ tempRoot: first.tempRoot })
try {
  await third.window.waitForFunction(() => window.dustdesk.getWidgetVisibility(['todo']).then(result => result.todo === false))
  console.log('Widget visibility persistence passed')
} finally {
  await closeDustDesk(third)
}
