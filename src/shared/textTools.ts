import type { TextRequest, TextResult } from './toolbox'

export const maxTextBytes = 10 * 1024 * 1024
export function processText(request: TextRequest): TextResult {
  const { input, tool } = request
  for (const text of [input, request.second ?? '']) if (new TextEncoder().encode(text).length > maxTextBytes) throw Error('每份文本最多 10 MiB')
  const lines = () => input.split(/\r?\n/).map(line => request.trim ? line.trim() : line).filter(line => !request.ignoreEmpty || line.trim().length)
  switch (tool) {
    case 'json': case 'jsonCompact': {
      try { return { text: JSON.stringify(JSON.parse(input), null, tool === 'json' ? 2 : undefined) } }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const position = /position (\d+)/.exec(message)?.[1]
        if (position) { const prefix = input.slice(0, Number(position)); const rows = prefix.split('\n'); throw Error(`JSON 错误：第 ${rows.length} 行，第 ${(rows.at(-1)?.length ?? 0) + 1} 列。${message}`) }
        throw Error('JSON 错误：' + message)
      }
    }
    case 'urlEncode': return { text: encodeURIComponent(input) }
    case 'urlDecode': try { return { text: decodeURIComponent(input) } } catch { throw Error('URL 编码无效：请检查百分号和 UTF-8 字节') }
    case 'base64Encode': {
      const bytes = new TextEncoder().encode(input); let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
      return { text: btoa(binary) }
    }
    case 'base64Decode': {
      const value = input.replace(/\s/g, '')
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw Error('Base64 编码无效')
      try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value), c => c.charCodeAt(0))) } } catch { throw Error('Base64 内容不是有效的 UTF-8 文本') }
    }
    case 'regex': {
      const expression = new RegExp(request.pattern ?? '', request.flags ?? 'g')
      const matches: { index: number; match: string; groups: (string | undefined)[]; named?: Record<string, string> }[] = []
      let match: RegExpExecArray | null
      while ((match = expression.exec(input))) {
        matches.push({ index: match.index, match: match[0], groups: match.slice(1), named: match.groups })
        if (matches.length >= 10000) throw Error('匹配超过 10000 项，请缩小输入或修改表达式')
        if (!expression.global && !expression.sticky) break
        if (match[0] === '') { const point = input.codePointAt(expression.lastIndex); expression.lastIndex += expression.unicode && point !== undefined && point > 65535 ? 2 : 1 }
      }
      return { text: JSON.stringify(matches, null, 2) }
    }
    case 'diff': return compareLines(input, request.second ?? '')
    case 'dedupe': return { text: [...new Set(lines())].join('\n') }
    case 'sort': return { text: lines().sort(new Intl.Collator('zh-CN', { numeric: true }).compare).join('\n') }
    case 'stats': return { text: `字符（Unicode 码点）：${[...input].length}\n字符（不含空白）：${[...input.replace(/\s/g, '')].length}\n行数：${input ? input.split(/\r?\n/).length : 0}\nUTF-8 字节：${new TextEncoder().encode(input).length}\n单词：${input.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0}` }
    case 'upper': return { text: input.toUpperCase() }
    case 'lower': return { text: input.toLowerCase() }
  }
}

// Myers' shortest edit path; retain only the frontier rather than an N×M table.
export function compareLines(left: string, right: string): TextResult {
  const a = left.split(/\r?\n/), b = right.split(/\r?\n/)
  const frontier = new Map<number, number>([[1, 0]]), trace: Map<number, number>[] = []
  for (let d = 0; d <= a.length + b.length; d++) {
    if (d > 2000) throw Error('文本差异过多，请缩小对比范围')
    trace.push(new Map(frontier))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1)) ? frontier.get(k + 1) ?? 0 : (frontier.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++ }
      frontier.set(k, x)
      if (x >= a.length && y >= b.length) {
        const diff: NonNullable<TextResult['diff']> = []
        for (let step = d; step >= 0; step--) {
          const v = trace[step]!, diagonal = x - y
          const previous = diagonal === -step || (diagonal !== step && (v.get(diagonal - 1) ?? -1) < (v.get(diagonal + 1) ?? -1)) ? diagonal + 1 : diagonal - 1
          const px = v.get(previous) ?? 0, py = px - previous
          while (x > px && y > py) { diff.push({ kind: 'same', text: a[--x]! }); y-- }
          if (step) { if (x === px) diff.push({ kind: 'add', text: b[--y]! }); else diff.push({ kind: 'remove', text: a[--x]! }) }
        }
        diff.reverse()
        return { diff, text: diff.map(row => (row.kind === 'add' ? '+ ' : row.kind === 'remove' ? '- ' : '  ') + row.text).join('\n') }
      }
    }
  }
  return { text: '' }
}
