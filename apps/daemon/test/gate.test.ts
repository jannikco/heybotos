import { describe, expect, it } from 'vitest'
import { connectorReads, decide, deployCommand, hostAllowed, remoteHosts, splitCommands, type GateConfig } from '../src/policy/gate.ts'

const cfg: GateConfig = { allowedHosts: ['localhost', 'github.com', 'buildbox', '*.internal.test'], alwaysAllowTools: ['blogtool/*'], askCommandPatterns: ['artisan\\s+migrate\\b.*--force'], hostGrantMinutes: 15, sshAgent: true }

describe('reading shell commands', () => {
  it('splits a line into simple commands and keeps quoted words whole', () => {
    expect(splitCommands(`cd app && FOO=1 pnpm build; echo "a b" 'c;d' | tee out.txt`)).toEqual([['cd', 'app'], ['FOO=1', 'pnpm', 'build'], ['echo', 'a b', 'c;d'], ['tee', 'out.txt']])
    expect(splitCommands('echo $(ssh web1 uptime)')).toEqual([['echo'], ['ssh', 'web1', 'uptime']])
  })

  it('finds the host in every way ssh is commonly called', () => {
    expect(remoteHosts('ssh web1 uptime')).toEqual(['web1'])
    expect(remoteHosts('ssh -p 2222 -i ~/.ssh/key -o StrictHostKeyChecking=no root@web1.example.com "cd /var/www && git pull"')).toEqual(['web1.example.com'])
    expect(remoteHosts('ssh -tt -p2222 deploy@10.0.0.5')).toEqual(['10.0.0.5'])
    expect(remoteHosts('cd build && sudo -E nohup /usr/bin/ssh web1 ls </dev/null &')).toEqual(['web1'])
    expect(remoteHosts('timeout 30 ssh web1 true || echo down')).toEqual(['web1'])
    expect(remoteHosts(`bash -lc 'ssh web1 "systemctl restart php"'`)).toEqual(['web1'])
    expect(remoteHosts('for h in a; do ssh "$h" true; done')).toEqual(['$h'])
    // The command that runs on the far side is not read as local commands.
    expect(remoteHosts('ssh buildbox "scp x web1:/tmp"')).toEqual(['buildbox'])
  })

  it('finds hosts in scp, rsync and sftp, and leaves local copies alone', () => {
    expect(remoteHosts('scp -r dist/ deploy@web1:/var/www/site')).toEqual(['web1'])
    expect(remoteHosts('rsync -rlpt --delete ./public/ web1:/var/www/public/')).toEqual(['web1'])
    expect(remoteHosts('rsync -a web1:/var/backups/db.sql buildbox:~/jobs/')).toEqual(['web1', 'buildbox'])
    expect(remoteHosts('rsync -a rsync://mirror.example.org/pub/ ./pub/')).toEqual(['mirror.example.org'])
    expect(remoteHosts('sftp sam@files.example.com:/inbox')).toEqual(['files.example.com'])
    expect(remoteHosts('rsync -a ./a/ ./b/ && scp one.txt two.txt && cp a:b c')).toEqual([])
    expect(remoteHosts('echo "ssh web1" && grep -r "scp host:" docs/')).toEqual([])
  })

  it('matches allowed hosts exactly or by sub-domain rule', () => {
    expect(hostAllowed('buildbox', cfg.allowedHosts)).toBe(true)
    expect(hostAllowed('GitHub.com', cfg.allowedHosts)).toBe(true)
    expect(hostAllowed('db.internal.test', cfg.allowedHosts)).toBe(true)
    expect(hostAllowed('web1', cfg.allowedHosts)).toBe(false)
    expect(hostAllowed('notgithub.com', cfg.allowedHosts)).toBe(false)
  })

  it('recognises deploy and publish commands', () => {
    expect(deployCommand('pnpm build && vercel --prod')).toBe('vercel --prod')
    expect(deployCommand('npm publish --access public')).toBe('npm publish --access public')
    expect(deployCommand('./deploy.sh production')).toBe('deploy.sh production')
    expect(deployCommand('dep deploy production')).toBe('dep deploy production')
    expect(deployCommand('docker push registry.example/app:1')).toBe('docker push registry.example/app:1')
    expect(deployCommand('pnpm install && pnpm test && git commit -m "deploy notes"')).toBeNull()
    expect(deployCommand('npm run build')).toBeNull()
    expect(deployCommand('docker build -t app .')).toBeNull()
  })
})

describe('connector tools', () => {
  it('lets tools that only look through, and holds everything that changes something', () => {
    for (const t of ['search-orders', 'get-order', 'list-machines', 'ledger-get-account', 'ledger-list-journals', 'ledger-preview-expense-voucher', 'whoami', 'production-dashboard', 'calculate-product-price', 'tool_get_recent_messages', 'tool_fuzzy_search_messages', 'read_only_sql', 'tail_error_log', 'search_memories', 'recent_memories']) {
      expect(connectorReads(t), t).toBe(true)
    }
    for (const t of ['create-invoice', 'ledger-export-invoice', 'ledger-send-expense', 'set-order-status', 'update-customer', 'tool_send_message', 'send_email', 'update_price', 'revoke_enrollment', 'delete_memory', 'save_memory', 'drop-file', 'ship-file', 'cancel-shipment', 'manual_fulfill', 'approve-expense', 'adjust-stock', 'something_new']) {
      expect(connectorReads(t), t).toBe(false)
    }
    // A word in front that names a part of the system does not hide what the tool does.
    for (const t of ['ledger_list_accounts', 'ledger_list', 'crm-get-contact', 'stock_overview', 'sales-dashboard']) expect(connectorReads(t), t).toBe(true)
    for (const t of ['bulk_delete_orders', 'crm-merge-get', 'safe_remove_list_items', 'dashboard_reset']) expect(connectorReads(t), t).toBe(false)
  })
})

describe('the decision', () => {
  it('allows ordinary work', () => {
    for (const command of ['pnpm test', 'git push origin main', 'ssh buildbox "cd ~/jobs && ./run.sh"', 'rsync -a ./out/ buildbox:~/jobs/out/', 'curl -s https://example.com', 'rm -rf node_modules && pnpm install']) {
      expect(decide(cfg, 'Bash', { command }), command).toEqual({ decision: 'allow' })
    }
    expect(decide(cfg, 'Edit', { file_path: '/x' })).toEqual({ decision: 'allow' })
    expect(decide(cfg, 'mcp__printshop__search-orders', { date: '2026-11-11' })).toEqual({ decision: 'allow' })
    expect(decide(cfg, 'mcp__heybotos__create_task', {})).toEqual({ decision: 'allow' })
    expect(decide(cfg, 'mcp__blogtool__publish_post', {})).toEqual({ decision: 'allow' })
  })

  it('asks before a server that is not on the list, a deploy command, a marked command, or a changing connector call', () => {
    expect(decide(cfg, 'Bash', { command: 'pnpm build && rsync -a dist/ root@web1:/var/www/site/' })).toMatchObject({ decision: 'ask', kind: 'host', key: 'web1', summary: 'Connect to the server web1' })
    expect(decide(cfg, 'Bash', { command: 'vercel --prod' })).toMatchObject({ decision: 'ask', kind: 'command' })
    expect(decide(cfg, 'Bash', { command: 'php artisan migrate --force' })).toMatchObject({ decision: 'ask', kind: 'command' })
    expect(decide(cfg, 'shim:ssh', { argv: ['-p', '22', 'root@web1', 'uptime'] })).toMatchObject({ decision: 'ask', kind: 'host', key: 'web1' })
    expect(decide(cfg, 'shim:ssh', { argv: ['git@github.com', "git-receive-pack 'x/y.git'"] })).toEqual({ decision: 'allow' })
    expect(decide(cfg, 'mcp__printshop__ledger-export-invoice', { invoice_id: 7 })).toMatchObject({ decision: 'ask', kind: 'tool', summary: 'Use printshop to ledger export invoice' })
    expect(decide(cfg, 'mcp__messages__tool_send_message', { to: 'x', text: 'hi' })).toMatchObject({ decision: 'ask', kind: 'tool' })
  })
})
