// Writes claude-rich.jsonl: a hand-built stream in the recorded shape (see claude-basic.jsonl) that
// exercises everything the transcript can draw. Synthetic, used for UI work and tests only.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sid = '11111111-2222-4333-8444-555555555555'
const out = []
const base = { session_id: sid }
const assistant = (content, parent = null) => out.push({ type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: parent, ...base })
const user = (content, parent = null) => out.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: parent, ...base })
const use = (id, name, input) => ({ type: 'tool_use', id, name, input })
const back = (id, content, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error })
const typing = (text, parent = null) => {
  for (const piece of text.match(/.{1,14}/gs) ?? []) out.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, parent_tool_use_id: parent, ...base })
}
const say = (text, parent = null) => {
  typing(text, parent)
  assistant([{ type: 'text', text }], parent)
}

out.push({ type: 'system', subtype: 'init', cwd: '/work/shop', model: 'model-large', permissionMode: 'bypassPermissions', apiKeySource: 'none', claude_code_version: '2.1.322', mcp_servers: [], ...base })
assistant([{ type: 'thinking', thinking: 'The header overlaps the nav below 720px. I should look at the stylesheet and the layout template first, then check how the tests cover it.' }])
say('I will look at how the header is laid out, then fix the overlap on narrow screens.')
assistant([use('t1', 'Read', { file_path: '/work/shop/resources/css/header.css' })])
user([back('t1', '1\t.site-header { position: fixed; height: 96px; }\n2\t.site-nav { margin-top: 64px; }')])
assistant([use('t2', 'Grep', { pattern: 'site-header', path: 'resources' })])
user([back('t2', 'resources/css/header.css\nresources/views/layout.blade.php\nresources/js/menu.ts')])
assistant([use('t3', 'Bash', { command: 'pnpm test --filter header', description: 'Run the header tests' })])
user([back('t3', 'FAIL  tests/header.spec.ts > keeps the nav clear of the header at 640px\n  expected 96 to be at most 64', true)])
say('The test confirms it: the header is **96px** tall but the nav only leaves `64px`. I am handing the search for other fixed offsets to a sub-agent while I fix this one.')
assistant([use('a1', 'Agent', { description: 'Find other hard-coded header offsets', prompt: 'Search the repo for any CSS or JS that assumes a 64px header.' })])
user([{ type: 'text', text: 'Search the repo for any CSS or JS that assumes a 64px header.' }], 'a1')
assistant([use('s1', 'Grep', { pattern: '64px', path: 'resources' })], 'a1')
user([back('s1', 'resources/css/header.css:2\nresources/js/menu.ts:14')], 'a1')
assistant([use('s2', 'Read', { file_path: '/work/shop/resources/js/menu.ts' })], 'a1')
user([back('s2', '14\tconst HEADER = 64 // px')], 'a1')
assistant([{ type: 'text', text: 'Two places assume 64px: the nav margin in header.css and a constant in menu.ts.' }], 'a1')
assistant([use('t4', 'Edit', { file_path: '/work/shop/resources/css/header.css', old_string: 'margin-top: 64px', new_string: 'margin-top: var(--header-h)' })])
user([back('t4', 'The file has been updated.')])
user([back('a1', 'Two places assume 64px: the nav margin in header.css (line 2) and the HEADER constant in menu.ts (line 14).')])
assistant([use('t5', 'Edit', { file_path: '/work/shop/resources/js/menu.ts', old_string: 'const HEADER = 64', new_string: 'const HEADER = headerHeight()' })])
user([back('t5', 'The file has been updated.')])
out.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.83, resetsAt: 1794463200, isUsingOverage: false, overageEnabled: false }, ...base })
assistant([use('t6', 'Bash', { command: 'pnpm test --filter header', description: 'Run the header tests again' })])
user([back('t6', 'PASS  tests/header.spec.ts (4 tests)\n\nTest Files  1 passed (1)')])
say('Fixed. The nav now follows the real header height instead of a fixed 64px, and the header tests pass.\n\n- `header.css` uses the `--header-h` variable\n- `menu.ts` reads the height at runtime')
assistant([use('so', 'StructuredOutput', { status: 'done' })])
user([back('so', 'ok')])
out.push({
  type: 'result', subtype: 'success', is_error: false, num_turns: 9, duration_ms: 48213, stop_reason: 'end_turn', total_cost_usd: 0.0412,
  result: 'Fixed. The nav now follows the real header height instead of a fixed 64px, and the header tests pass.',
  structured_output: {
    status: 'done',
    summary: 'The nav no longer slides under the header on narrow screens. Both places that assumed a 64px header now use the real height.',
    files_changed: ['resources/css/header.css', 'resources/js/menu.ts'],
    verification: 'Ran the header tests before (1 failing at 640px) and after (4 passing).',
    question: '',
    follow_ups: ['The footer has the same kind of fixed offset on the checkout page.'],
  },
  usage: { input_tokens: 40, cache_creation_input_tokens: 9000, cache_read_input_tokens: 52000, output_tokens: 1840 },
  permission_denials: [], ...base,
})

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'claude-rich.jsonl'), out.map((l) => JSON.stringify(l)).join('\n') + '\n')
console.log(`${out.length} lines`)
