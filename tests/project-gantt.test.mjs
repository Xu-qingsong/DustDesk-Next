import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import ts from 'typescript'

const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')
const dates = moduleUrl(await fs.readFile('src/renderer/src/utils/dates.ts', 'utf8'))
const source = (await fs.readFile('src/renderer/src/utils/gantt.ts', 'utf8')).replace("from './dates'", `from '${dates}'`)
const { ganttDay, ganttDate, phaseSchedule, ganttAxis } = await import(moduleUrl(source))
const phase = (start, end) => ({ StartDate: start, EndDate: end })

test('gantt dates count inclusive calendar days across months, leap years and DST', () => {
  for (const [start, end, days] of [['2026-10-07', '2026-10-07', 1], ['2026-01-30', '2026-02-03', 5], ['2024-02-28', '2024-03-01', 3], ['2026-03-07', '2026-03-09', 3], ['2026-12-31', '2027-01-02', 3]]) {
    assert.equal(phaseSchedule(phase(start, end)).days, days)
    assert.equal(ganttDate(ganttDay(start)), start)
  }
  for (const value of [null, '', 'invalid', '2026-02-30', '2026-13-01']) assert.equal(ganttDay(value), null)
  assert.equal(phaseSchedule(phase('2026-10-08', '2026-10-07')).invalid, true)
  assert.equal(phaseSchedule(phase('2026-10-08', null)).days, null)
})

test('gantt scales share exact date positions and cover all valid schedules', () => {
  const phases = [phase('2026-01-30', '2026-03-01'), phase(null, '2026-03-15'), phase(null, null)]
  for (const scale of ['day', 'week', 'month']) {
    const axis = ganttAxis(phases, scale, new Date('2026-02-01T12:00:00'))
    assert.ok(axis.start <= ganttDay('2026-01-30'))
    assert.ok(axis.end >= ganttDay('2026-03-15'))
    assert.equal(axis.width, axis.days * axis.pixelsPerDay)
    assert.equal(axis.ticks.reduce((sum, tick) => sum + tick.days, 0), axis.days)
    assert.equal(axis.ticks[0].start, axis.start)
    if (scale === 'week') assert.equal(new Date(axis.start * 86400000).getUTCDay(), 1)
    if (scale === 'month') assert.equal(ganttDate(axis.start).slice(8), '01')
  }
  assert.equal(ganttAxis([phase('2020-01-01', '2026-12-31')]).scale, 'month')
  const large = ganttAxis([phase('1900-01-01', '2099-12-31')], 'day')
  assert.ok(large.ticks.length <= 500)
  assert.ok(large.width <= 100000)
  const empty = ganttAxis([phase(null, null)], 'day', new Date('2026-10-07T12:00:00'))
  assert.ok(empty.today >= empty.start && empty.today <= empty.end)
  const fitted = ganttAxis([phase('2026-10-01', '2026-10-21')], undefined, new Date('2026-10-07T12:00:00'), 380)
  assert.ok(fitted.width <= 380)
  assert.ok(fitted.ticks.every(tick => tick.days * fitted.pixelsPerDay >= 24 || tick.start + tick.days === fitted.end + 1))
})
