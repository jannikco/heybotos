#!/usr/bin/env node
// Stand-in for a connector program (an MCP server on stdin/stdout) in tests: a tiny shop system
// with one tool that looks and one that changes something.
import { appendFileSync } from 'node:fs'

const TOOLS = [
  { name: 'search-orders', description: 'Find orders.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'create-order', description: 'Create an order.', inputSchema: { type: 'object', properties: { customer: { type: 'string' } } } },
]
const log = (what) => process.env.FAKE_CONNECTOR_LOG && appendFileSync(process.env.FAKE_CONNECTOR_LOG, `${what}\n`)
const say = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    if (!line.trim()) continue
    const req = JSON.parse(line)
    if (req.id === undefined) continue
    if (req.method === 'initialize') say({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-shop', version: '1' } } })
    else if (req.method === 'tools/list') say({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } })
    else if (req.method === 'tools/call') {
      log(`${req.params.name} ${JSON.stringify(req.params.arguments)}`)
      const text = req.params.name === 'search-orders' ? `Order 4711 for ${process.env.SHOP_KEY ?? 'nobody'}` : `Created an order for ${req.params.arguments.customer}`
      say({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text }] } })
    } else say({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Unknown method.' } })
  }
})
