// Turns what an agent wrote (Markdown) into safe HTML. Raw HTML in the text stays text, images are
// never fetched, and only http and https links become links, so nothing an agent writes can run in
// the page or make it call an outside address.
import MarkdownIt, { type StateCore, type Token } from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
md.disable(['image', 'code'])
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false })
md.validateLink = (url) => /^https?:\/\//i.test(url.trim())

const esc = md.utils.escapeHtml

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx]!.attrSet('target', '_blank')
  tokens[idx]!.attrSet('rel', 'noopener noreferrer')
  return self.renderToken(tokens, idx, options)
}

// The page has its own headings; an agent's start two levels down.
const level = (t: Token) => `h${Math.min(6, Number(t.tag.slice(1)) + 2)}`
md.renderer.rules.heading_open = (tokens, idx) => `<${level(tokens[idx]!)}>`
md.renderer.rules.heading_close = (tokens, idx) => `</${level(tokens[idx]!)}>\n`

md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx]!
  const lang = t.info.trim().split(/\s+/)[0] ?? ''
  return `<div class="md-code">${lang ? `<span class="md-lang">${esc(lang)}</span>` : ''}<button type="button" class="md-copy" data-copy="code">Copy</button><pre><code>${esc(t.content.replace(/\n$/, ''))}</code></pre></div>\n`
}

// A table gets a frame it can scroll in when it is wider than the text around it.
md.renderer.rules.table_open = () => '<div class="md-table"><div class="md-scroll"><table>\n'
md.renderer.rules.table_close = () => '</table></div><button type="button" class="md-copy" data-copy="table">Copy table</button></div>\n'

const NUMBER = /^[-+−–]?\s*[$€£]?\s*\d[\d\s.,:]*\s*(%|[a-zA-Z€$£]{1,4}\.?)?$/
const plain = (s: string) => s.replace(/[*_`~]/g, '').trim()

/**
 * Says how each column of a table should be set: numbers to the right in even figures, short
 * columns on one line, and the alignment the writer asked for as a class instead of an inline style.
 */
function shapeTables(tokens: Token[]): void {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.type !== 'table_open') continue
    const cells: Array<{ open: Token; col: number; head: boolean; text: string }> = []
    let col = 0
    let head = false
    for (i++; i < tokens.length && tokens[i]!.type !== 'table_close'; i++) {
      const t = tokens[i]!
      if (t.type === 'thead_open') head = true
      else if (t.type === 'thead_close') head = false
      else if (t.type === 'tr_open') col = 0
      else if (t.type === 'th_open' || t.type === 'td_open') cells.push({ open: t, col: col++, head, text: plain(tokens[i + 1]?.content ?? '') })
    }
    const columns = Math.max(0, ...cells.map((c) => c.col + 1))
    for (let c = 0; c < columns; c++) {
      const column = cells.filter((x) => x.col === c)
      const body = column.filter((x) => !x.head && x.text)
      const numbers = body.length > 0 && body.every((x) => NUMBER.test(x.text))
      const tight = Math.max(0, ...column.map((x) => x.text.length)) <= 24
      for (const cell of column) {
        const asked = /text-align:(left|center|right)/.exec(String(cell.open.attrGet('style') ?? ''))?.[1]
        cell.open.attrs = (cell.open.attrs ?? []).filter(([name]) => name !== 'style')
        const classes = [asked ? `al-${asked}` : numbers ? 'al-right' : '', numbers ? 'num' : '', tight ? 'tight' : '', c === 0 && tight && !numbers ? 'lead' : '']
        const list = classes.filter(Boolean).join(' ')
        if (list) cell.open.attrSet('class', list)
      }
    }
  }
}

/** `- [ ] to do` and `- [x] done` become list items with a drawn box. */
function taskLists(tokens: Token[], Tok: StateCore['Token']): void {
  for (let i = 0; i + 2 < tokens.length; i++) {
    const item = tokens[i]!
    const text = tokens[i + 2]!
    if (item.type !== 'list_item_open' || tokens[i + 1]!.type !== 'paragraph_open' || text.type !== 'inline') continue
    const first = text.children?.[0]
    const mark = /^\[([ xX])\]\s+/.exec(first?.type === 'text' ? first.content : '')
    if (!first || !mark) continue
    const done = mark[1] !== ' '
    first.content = first.content.slice(mark[0].length)
    text.content = text.content.slice(mark[0].length)
    const box = new Tok('html_inline', '', 0)
    box.content = `<span class="md-box${done ? ' done' : ''}" role="img" aria-label="${done ? 'Done' : 'To do'}"></span>`
    text.children!.unshift(box)
    item.attrJoin('class', 'task')
  }
}

md.core.ruler.push('heybotos_shape', (state) => {
  shapeTables(state.tokens)
  taskLists(state.tokens, state.Token)
})

export function renderMarkdown(src: string): string {
  return md.render(src.replace(/\r/g, ''))
}

/**
 * For text that is still being written: the first line or two of a table are held back until the
 * table can be drawn, so its pipes and dashes never show as text.
 */
export function settle(src: string): string {
  const lines = src.split('\n')
  let run = 0
  while (run < lines.length && lines[lines.length - 1 - run]!.trimStart().startsWith('|')) run++
  if (run === 0 || run > 2) return src
  const pipes = (s: string) => s.split('|').length
  const drawn = run === 2 && /^[\s|:-]+$/.test(lines.at(-1)!) && pipes(lines.at(-1)!) >= pipes(lines.at(-2)!)
  return drawn ? src : lines.slice(0, lines.length - run).join('\n')
}
