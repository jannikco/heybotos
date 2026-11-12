import { describe, expect, it } from 'vitest'
import { renderMarkdown, settle } from '../src/markdown'

const TEAM = `Du har fem workers i dag. Hver tager en bestemt slags arbejde:

| Navn | Rolle | Tager | Hvad de gør |
|---|---|---|---|
| **Ada** | Engineer | build, other | Bygger og ændrer kode: nye funktioner, fejlrettelser, opsætning |
| **Rex** | Reviewer | review | Læser andres arbejde kritisk. Reviews går som standard til den anden motor (Codex), så de ikke bedømmer deres eget arbejde |
| **Iris** | Researcher | research | Læser og undersøger uden at ændre noget, som undersøgelsen af dine projekter |
| **Wren** | Writer | write | Skriver tekster, dokumenter og indhold |
| **Otto** | Operator | ops | Kører kommandoer og tjekker servere, som SSH-testen til \`web1\` |

Jeg vælger ikke en bestemt worker.`

const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0

describe('renderMarkdown', () => {
  it('draws a table as a table, not as pipes', () => {
    const html = renderMarkdown(TEAM)
    expect(count(html, /<table>/g)).toBe(1)
    expect(count(html, /<th[ >]/g)).toBe(4)
    expect(count(html, /<tr>/g)).toBe(6)
    expect(count(html, /<td[ >]/g)).toBe(20)
    expect(html).not.toContain('|')
    expect(html).toContain('<strong>Ada</strong>')
    expect(html).toContain('<code>web1</code>')
    expect(html).toContain('data-copy="table"')
    // Short columns stay on one line and the first one leads; the long one is free to wrap.
    expect(html).toContain('<td class="tight lead"><strong>Ada</strong></td>')
    expect(html).toMatch(/<td>Bygger og ændrer kode/)
  })

  it('sets numbers to the right and keeps the alignment that was asked for', () => {
    const html = renderMarkdown('| Engine | Turns | Share |\n|:--|--:|:-:|\n| Claude | 1.204 | 83% |\n| Codex | 96 | 7% |')
    expect(html).toContain('<td class="al-right num tight">1.204</td>')
    expect(html).toContain('<td class="al-center num tight">83%</td>')
    expect(html).toContain('<td class="al-left tight lead">Claude</td>')
    expect(html).not.toContain('style=')
  })

  it('keeps lists inside lists, quotes, rules and emphasis', () => {
    const html = renderMarkdown('1. First\n   - inner one\n   - inner two\n2. Second\n\n> said *before*\n\n---\n\n~~gone~~')
    expect(html).toMatch(/<ol>\s*<li>First\s*<ul>\s*<li>inner one<\/li>/)
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<em>before</em>')
    expect(html).toContain('<hr>')
    expect(html).toContain('<s>gone</s>')
  })

  it('draws task lists with a box', () => {
    const html = renderMarkdown('- [x] tests pass\n- [ ] deploy')
    expect(html).toContain('<li class="task"><span class="md-box done" role="img" aria-label="Done"></span>tests pass</li>')
    expect(html).toContain('aria-label="To do"></span>deploy')
  })

  it('starts headings below the page’s own', () => {
    const html = renderMarkdown('# Top\n\n## Next\n\n##### Deep')
    expect(html).toContain('<h3>Top</h3>')
    expect(html).toContain('<h4>Next</h4>')
    expect(html).toContain('<h6>Deep</h6>')
  })

  it('keeps a single line break', () => {
    expect(renderMarkdown('one\ntwo')).toContain('one<br>')
  })

  it('never lets HTML an agent wrote through', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nhello <b>there</b>\n\n| a | b |\n|---|---|\n| <i>x</i> | <svg onload=alert(1)> |')
    expect(html).not.toMatch(/<script|<img|<b>|<i>|<svg/)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;svg onload=alert(1)&gt;')
  })

  it('makes only web links into links, and opens them outside', () => {
    const html = renderMarkdown('[ok](https://example.org/a) [bad](javascript:alert(1)) [data](data:text/html,x) [file](./notes.md) see https://example.org/b and web1.example.org and me@example.org')
    expect(count(html, /<a /g)).toBe(2)
    expect(html).toContain('<a href="https://example.org/a" target="_blank" rel="noopener noreferrer">ok</a>')
    expect(html).toContain('<a href="https://example.org/b"')
    expect(html).not.toMatch(/href="(javascript|data|\.\/|mailto)/)
  })

  it('never fetches an image', () => {
    const html = renderMarkdown('![pixel](https://example.org/track.png)')
    expect(html).not.toContain('<img')
  })

  it('leaves a code block as it was written', () => {
    const html = renderMarkdown('```sh\nls | grep "a" && echo **no** <b>\n```\n\n    four spaces is still text')
    expect(html).toContain('<pre><code>ls | grep &quot;a&quot; &amp;&amp; echo **no** &lt;b&gt;</code></pre>')
    expect(html).toContain('<span class="md-lang">sh</span>')
    expect(html).toContain('data-copy="code"')
    expect(count(html, /<pre>/g)).toBe(1)
  })
})

describe('settle', () => {
  it('holds a table back until it can be drawn', () => {
    expect(settle('Here:\n\n| Na')).toBe('Here:\n')
    expect(settle('Here:\n\n| Name | Role |\n|---|')).toBe('Here:\n')
    expect(settle('Here:\n\n| Name | Role |\n|---|---|')).toContain('|---|---|')
    expect(settle('Here:\n\n| Name | Role |\n|---|---|\n| Ad')).toContain('| Ad')
    expect(settle('plain text')).toBe('plain text')
  })
})
