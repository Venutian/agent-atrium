/**
 * A demo office: made-up threads in made-up repos, for trying Agent Atrium without any agents
 * installed and for screenshots that show nobody's real work.
 *
 * Turned on by `npm run demo` (`node server/serve.mjs --demo`), which also points the saved
 * layout at `data/demo/` so the demo never touches your own office. Nothing in a demo thread
 * leads anywhere: opening, messaging and new conversations are refused by the API.
 */
export const DEMO = process.env.AGENT_ATRIUM_DEMO === '1'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

const AGENTS = {
  claude: { harness: 'claude-code', harnessName: 'Claude Code', model: 'claude-opus-5-5' },
  codex: { harness: 'codex', harnessName: 'Codex', model: 'gpt-5.5-codex' },
  vscode: { harness: 'vscode-chat', harnessName: 'VS Code Chat', model: 'local-qwen3-coder' },
}

// [agent, project, branch, title, preview, state, minutes since last activity]
const ROWS = [
  ['claude', 'storefront', 'feat/checkout-v2', 'Rebuild the checkout flow', 'Splitting the payment step into its own route', 'working', 1],
  ['codex', 'storefront', 'fix/cart-rounding', 'Fix cart total rounding', 'The totals now round once, at the end. Ready for review.', 'waiting', 6],
  ['claude', 'storefront', 'chore/a11y-audit', 'Accessibility pass on product pages', 'Contrast and focus order fixed on 14 pages', 'idle', 180],
  ['vscode', 'storefront', 'main', 'Explain the pricing service', 'Walked through the discount pipeline', 'idle', 2900],
  ['claude', 'payments-api', 'feat/idempotency', 'Add idempotency keys to charges', 'Writing the migration for the keys table', 'working', 2],
  ['codex', 'payments-api', 'fix/webhook-retry', 'Retry failed webhooks with backoff', 'Integration tests fail: the sandbox rejects the signing secret', 'blocked', 14],
  ['claude', 'payments-api', 'feat/refunds', 'Partial refunds', 'Merged after review', 'done', 45],
  ['codex', 'mobile-app', 'feat/offline-sync', 'Offline sync for the order list', 'Queueing writes while the device is offline', 'working', 0],
  ['claude', 'mobile-app', 'fix/ios-keyboard', 'Keyboard covers the login field on iOS', 'Which devices should I test on before I ship this?', 'waiting', 3],
  ['vscode', 'mobile-app', 'main', 'Upgrade to the new navigation API', 'Two screens left to migrate', 'working', 4],
  ['claude', 'docs-site', 'docs/quickstart', 'Rewrite the quickstart', 'New five-minute guide drafted', 'waiting', 25],
  ['codex', 'docs-site', 'chore/links', 'Fix broken links', '38 links updated', 'idle', 600],
  ['claude', 'ml-pipeline', 'feat/eval-harness', 'Evaluation harness for the ranking model', 'Running the baseline over the held-out set', 'working', 1],
  ['codex', 'ml-pipeline', 'perf/feature-cache', 'Cache features between runs', 'Cold start dropped from 9 min to 40 s', 'done', 90],
  ['claude', 'infra', 'feat/preview-envs', 'Preview environments per pull request', 'Terraform plan is clean', 'idle', 240],
  ['codex', 'infra', 'fix/dns-ttl', 'Lower DNS TTL before the migration', 'Needs a decision: 60 s or 300 s?', 'waiting', 11],
]

/** Plausible recorded usage, spread over the last two weeks, so the office stats have a story. */
function usage(seed, agent, now) {
  const model = AGENTS[agent].model
  const byDay = []
  const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  for (let d = 0; d < 14; d++) {
    if ((seed + d) % 3 === 0) continue
    const input = 40000 + ((seed * 7919 + d * 104729) % 260000)
    const output = Math.round(input * 0.09)
    const cached = Math.round(input * 0.62)
    const row = { day: new Date(now - d * DAY).toISOString().slice(0, 10), model, inputTokens: input, outputTokens: output,
      cachedInputTokens: cached, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: input + output }
    byDay.push(row)
    for (const k of Object.keys(totals)) totals[k] += row[k]
  }
  return { ...totals, known: true, coverage: 'recorded', observedAt: now, context: null, limits: [],
    byModel: [{ model, ...totals }], byDay: byDay.reverse() }
}

export function demoThreads(now = Date.now()) {
  return ROWS.map(([agent, project, gitBranch, title, preview, state, minutes], i) => ({
    id: `demo:${i}`, title, preview, project, projectPath: '', cwd: '', worktree: '', gitBranch, effort: '',
    ...AGENTS[agent],
    createdAt: now - (minutes + 60 + i * 37) * 60000, lastActivityAt: now - minutes * 60000, lastFocusedAt: 0,
    running: state === 'working', unread: state === 'waiting', hasError: state === 'blocked', archived: false,
    prState: state === 'done' ? 'MERGED' : '', sizeBytes: 200000 + i * 51000,
    canOpen: false, source: 'demo', ref: {}, usage: usage(i + 1, agent, now),
  }))
}
