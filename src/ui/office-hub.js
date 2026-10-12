import { filterCrew, morningBriefing, dailyUsage, phase } from '../game/office-data.js'
import { formatTokens } from './usage.js'

const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const date = at => at ? new Date(at).toLocaleString() : 'Not recorded'
const portrait = `<svg class="atlas-portrait" viewBox="0 0 100 100" aria-hidden="true"><rect x="13" y="10" width="74" height="57" rx="15" fill="#244655"/><rect x="20" y="17" width="60" height="41" rx="10" fill="#091b24"/><path d="M34 32v9m32-9v9m-25 8h18" stroke="#82edc6" stroke-width="6" stroke-linecap="round"/><path d="M50 5v5" stroke="#f4c968" stroke-width="5"/><path d="M27 76h46l9 20H18z" fill="#28546b"/><path d="M50 73l7 7-7 14-7-14z" fill="#f4c968"/></svg>`

/** The director's room is a playable index to real data, never a simulation of progress. */
export class OfficeHub {
  constructor(hud) {
    this.hud = hud; this.actions = hud.actions; this.threads = []; this.office = {}; this.view = 'briefing'
    const sheet = hud.$('.usage-sheet')
    hud.$('#usage-title').textContent = "Atlas's office"
    hud.$('.usage-sheet header p').textContent = 'Director’s room · your crew, energy and next missions'
    hud.$('#btn-close-usage').setAttribute('aria-label', 'Leave the director’s room')
    const tabs = document.createElement('nav'); tabs.className = 'office-nav'; tabs.setAttribute('aria-label', 'Director office stations')
    tabs.innerHTML = [['briefing', 'Daily briefing'], ['energy', 'Energy lab'], ['missions', 'Mission board'], ['chronicle', 'Chronicle'], ['workshop', 'Workshop']]
      .map(([id, name]) => `<button class="btn" data-office-view="${id}" aria-pressed="${id === this.view}">${name}</button>`).join('')
    sheet.querySelector('header').after(tabs)
    this.energy = hud.$('.usage-body'); this.energy.classList.add('office-energy'); this.energy.hidden = true
    this.energy.insertAdjacentHTML('afterbegin', `<section class="energy-console"><h3>Daily energy trail</h3><p class="usage-note">Recorded token activity over 14 UTC days. Cached input is included; this is not money spent.</p><label class="office-field">Model<select id="energy-model"><option value="">Every model</option></select></label><div class="energy-chart"></div>
      <div class="energy-budget"><label class="office-field">Daily token budget · UTC · 0 disables<input id="energy-budget" type="number" min="0" max="10000000000" step="1000"></label><label class="office-field">Warn below this allowance %<input id="energy-threshold" type="number" min="1" max="99" step="1"></label></div><div class="energy-warnings"></div></section>`)
    this.panes = {}
    for (const id of ['briefing', 'missions', 'chronicle', 'workshop']) {
      const pane = document.createElement('div'); pane.className = `office-pane office-${id}`; pane.hidden = id !== this.view
      sheet.appendChild(pane); this.panes[id] = pane
    }
    this.panes.missions.innerHTML = `<section><h3>Crew locator</h3><p class="usage-note">Search the floor and the rooms you put away. Visiting a bot returns to the office.</p><div class="crew-filters"><input id="crew-query" aria-label="Search crew" placeholder="Task, repo, model or branch…"><select id="crew-status" aria-label="Crew status"><option value="">Every status</option>${['working', 'waiting', 'blocked', 'idle', 'archived'].map(s => `<option>${s}</option>`).join('')}</select><select id="crew-harness" aria-label="Assistant"></select><select id="crew-model" aria-label="Model"></select><select id="crew-repo" aria-label="Repository"></select></div><div class="crew-results"></div></section>
      <section class="mission-station"><h3>Prepare a handoff</h3><p class="usage-note">Create a sealed briefing for another bot. Review the packet, then deliver it to the agent’s app. No model runs automatically.</p><form id="mission-form"><div class="mission-pair"><label class="office-field">From<select name="sourceId" required></select></label><label class="office-field">To<select name="targetId" required></select></label></div><label class="office-field">Mission brief<textarea name="brief" rows="3" maxlength="8000" required placeholder="What should the next agent do? Include the acceptance criteria."></textarea></label><button class="btn primary" type="submit">Seal mission packet</button><p class="mission-error" role="status"></p></form><div class="mission-list"></div></section>`
    tabs.addEventListener('click', event => { const button = event.target.closest('[data-office-view]'); if (button) this.show(button.dataset.officeView) })
    this.energy.querySelector('#energy-model').addEventListener('change', () => this.renderEnergy())
    for (const [id, key, min, max] of [['energy-budget', 'dailyTokenBudget', 0, 1e10], ['energy-threshold', 'quotaThreshold', 1, 99]]) {
      const input = this.energy.querySelector(`#${id}`); input.value = hud.settings.get(key)
      input.addEventListener('change', () => { const value = Math.min(max, Math.max(min, Number(input.value) || min)); input.value = value; hud.settings.set(key, value); this.actions.refreshOffice?.() })
    }
    for (const input of this.panes.missions.querySelectorAll('.crew-filters input, .crew-filters select')) input.addEventListener('input', () => this.renderCrew())
    this.panes.missions.querySelector('#mission-form').addEventListener('submit', async event => {
      event.preventDefault(); if (this.busy) return
      const form = event.currentTarget, button = form.querySelector('button'); this.busy = true; button.disabled = true
      try {
        await this.actions.createMission?.(Object.fromEntries(new FormData(form)))
        form.elements.brief.value = ''; form.querySelector('.mission-error').textContent = 'Mission sealed. Open the packet below before delivering it.'
      } catch (err) { form.querySelector('.mission-error').textContent = err.message || 'Could not seal this mission' }
      finally { this.busy = false; button.disabled = false }
    })
    sheet.addEventListener('click', async event => {
      const target = event.target.closest('[data-office-action]'); if (!target) return
      const action = target.dataset.officeAction, id = target.dataset.id
      if (action === 'visit') { hud.toggleUsage(false); this.actions.visitCrew?.(id); return }
      if (action === 'room') { hud.toggleUsage(false); this.actions.visitRoom?.(id); return }
      if (action === 'refresh') { target.disabled = true; try { await this.actions.refreshOffice?.() } finally { target.disabled = false }; return }
      const mission = this.office.missions?.find(m => m.id === id)
      if (!mission) return
      target.disabled = true
      try {
        if (action === 'deliver') await this.actions.deliverMission?.(mission)
        else await this.actions.updateMission?.(id, action)
      } catch (err) { hud.toast(err.message || 'Mission action failed', 'err') }
      finally { if (target.isConnected) target.disabled = false }
    })
    this.render()
  }

  setData(threads, office, report, warnings = []) {
    this.threads = threads; this.office = office || {}; this.report = report; this.warnings = warnings
    this.render()
  }
  show(view = 'briefing') {
    this.view = view
    for (const button of this.hud.el.querySelectorAll('[data-office-view]')) button.setAttribute('aria-pressed', String(button.dataset.officeView === view))
    this.energy.hidden = view !== 'energy'
    for (const [id, pane] of Object.entries(this.panes)) pane.hidden = id !== view
    this.render()
  }
  onOpen(view = 'briefing') { this.show(view) }
  render() {
    if (this.view === 'briefing') this.renderBriefing()
    if (this.view === 'missions') { this.syncChoices(); this.renderCrew(); this.renderMissions() }
    if (this.view === 'chronicle') this.renderChronicle()
    if (this.view === 'workshop') this.renderWorkshop()
    if (this.view === 'energy') { this.hud._renderUsage(); this.renderEnergy() }
  }
  renderBriefing() {
    const brief = morningBriefing(this.threads, this.office), xp = this.office.xp || 0, level = 1 + Math.floor(xp / 500)
    const task = (t, label) => `<button class="quest-task ${phase(t)}" data-office-action="visit" data-id="${e(t.id)}"><span class="quest-gem"></span><span><strong>${e(t.title)}</strong><small>${e(t.project)} · ${e(label)}</small></span><span>Visit ↗</span></button>`
    this.panes.briefing.innerHTML = `<div class="atlas-welcome">${portrait}<div><span class="office-eyebrow">DIRECTOR ATLAS · ${e(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))}</span><h2>${brief.blocked.length ? 'The crew needs a captain.' : brief.waiting.length ? 'Your review desk is ready.' : 'Welcome back to the office.'}</h2><p>${e(brief.suggestion)}</p></div></div>
      <div class="office-rank"><span>Coordinator · level ${level}</span><strong>${xp} office XP</strong><progress value="${xp % 500}" max="500" aria-label="Progress to the next coordinator level"></progress><small>Earn 100 XP when you mark a mission complete. This is an organising game, not a measure of agent quality.</small></div>
      <div class="brief-scoreboard">${[['On shift', brief.working.length], ['Needs a decision', brief.blocked.length], ['Ready for review', brief.waiting.length], ['Missions cleared today', brief.shipped.length]].map(([label, count]) => `<div><strong>${count}</strong><span>${label}</span></div>`).join('')}</div>
      <h3>Next moves</h3><div class="quest-list">${[...brief.blocked.slice(0, 3).map(t => task(t, 'Unblock this agent')), ...brief.waiting.slice(0, 3).map(t => task(t, 'Review the latest turn'))].join('') || '<div class="quest-empty">No red or blue beacons. Explore the Mission board to plan the next move.</div>'}</div>
      <div class="brief-bottom"><article class="quest-card"><h3>Dispatch desk</h3><p>${brief.missions.length} open mission packets · ${brief.merged.length} merged PRs in the latest repo snapshot.</p><button class="btn" data-office-view="missions">Go to mission board</button></article><article class="quest-card"><h3>Energy watch</h3><p>${this.warnings?.length ? e(this.warnings.map(w => w.text).join(' ')) : 'No fresh low-allowance reports. Unreported balances remain unknown.'}</p><button class="btn" data-office-view="energy">Inspect energy meters</button></article></div>
      <p class="usage-note">Briefing uses local session state and events observed since ${e(date(this.office.firstObservedAt))}; it does not generate a summary through an LLM.</p>`
    for (const b of this.panes.briefing.querySelectorAll('[data-office-view]')) b.addEventListener('click', () => this.show(b.dataset.officeView))
  }
  renderEnergy() {
    const select = this.energy.querySelector('#energy-model'), selected = select.value
    const models = [...new Set((this.report?.byDay || []).map(r => r.model))].sort()
    const choices = JSON.stringify(models)
    if (choices !== this.modelChoices) { this.modelChoices = choices; select.innerHTML = '<option value="">Every model</option>' + models.map(m => `<option>${e(m)}</option>`).join(''); select.value = models.includes(selected) ? selected : '' }
    const days = dailyUsage(this.report?.byDay || [], { model: select.value }), max = Math.max(1, ...days.map(d => d.totalTokens))
    this.energy.querySelector('.energy-chart').innerHTML = `<svg viewBox="0 0 760 210" role="img" aria-label="14-day recorded token activity in UTC"><line x1="20" y1="170" x2="744" y2="170" stroke="currentColor" opacity=".2"/>${days.map((d, i) => {
      const height = d.totalTokens / max * 130, x = 27 + i * 51, cached = d.totalTokens ? Math.min(1, d.cachedInputTokens / d.totalTokens) * height : 0
      return `<g><title>${d.day}: ${formatTokens(d.totalTokens)} tokens; ${formatTokens(d.cachedInputTokens)} cached input; ${formatTokens(d.outputTokens)} output</title><rect x="${x}" y="${170 - height}" width="34" height="${Math.max(height, 1)}" rx="4" fill="var(--blue)"/><rect x="${x}" y="${170 - cached}" width="34" height="${cached}" rx="3" fill="var(--teal)"/><text x="${x + 17}" y="190" text-anchor="middle" font-size="10" fill="currentColor">${d.day.slice(5)}</text></g>`
    }).join('')}</svg><p class="usage-note">Teal: cached input · blue: other recorded tokens. Peak: ${formatTokens(max === 1 ? 0 : max)}. A missing day has no recorded usage, not proof of no account activity.</p>`
    this.energy.querySelector('.energy-warnings').innerHTML = (this.warnings || []).map(w => `<div class="energy-warning">${e(w.text)}</div>`).join('')
  }
  syncChoices() {
    const pane = this.panes.missions
    const choices = (select, rows, placeholder) => {
      const key = JSON.stringify(rows); if (select.dataset.choices === key) return
      select.dataset.choices = key; const value = select.value
      select.innerHTML = `<option value="">${placeholder}</option>` + rows.map(([id, label]) => `<option value="${e(id)}">${e(label)}</option>`).join('')
      if (rows.some(([id]) => id === value)) select.value = value
    }
    const distinct = (field, label = field) => [...new Map(this.threads.filter(t => t[field]).map(t => [t[field], t[label] || t[field]])).entries()]
    choices(pane.querySelector('#crew-harness'), distinct('harness', 'harnessName'), 'Every assistant')
    choices(pane.querySelector('#crew-model'), distinct('model'), 'Every model')
    choices(pane.querySelector('#crew-repo'), distinct('project'), 'Every repository')
    const rows = this.threads.filter(t => !t.parentId && !t.archived).map(t => [t.id, `${t.project} · ${t.harnessName || 'Agent'} · ${t.title}`])
    for (const name of ['sourceId', 'targetId']) choices(pane.querySelector(`[name="${name}"]`), rows, name === 'sourceId' ? 'Choose the source bot' : 'Choose the receiving bot')
  }
  renderCrew() {
    const pane = this.panes.missions
    const value = id => pane.querySelector(`#crew-${id}`).value
    const filtered = filterCrew(this.threads, { query: value('query'), status: value('status'), harness: value('harness'), model: value('model'), repo: value('repo') })
    pane.querySelector('.crew-results').innerHTML = `<p class="usage-note">${filtered.length} crew sessions found</p><div class="quest-list">${filtered.slice(0, 80).map(t => `<button class="quest-task ${phase(t)}" data-office-action="visit" data-id="${e(t.id)}"><span class="quest-gem"></span><span><strong>${e(t.title)}</strong><small>${e(t.project)} · ${e(t.model || t.harnessName || 'Model unknown')}</small></span><span>${phase(t)}</span></button>`).join('') || '<div class="quest-empty">No matching crew. Try a different search or clear a filter.</div>'}</div>`
  }
  renderMissions() {
    const missions = this.office.missions || [], signature = JSON.stringify(missions)
    if (signature === this.missionSignature) return
    this.missionSignature = signature
    const list = this.panes.missions.querySelector('.mission-list')
    const open = new Set([...list.querySelectorAll('details[open]')].map(d => d.closest('[data-mission-id]').dataset.missionId))
    list.innerHTML = missions.map(m => `<article class="mission-packet ${e(m.status)}" data-mission-id="${e(m.id)}"><div><span class="office-eyebrow">${e(m.status)} · ${e(m.project)}</span><h4>${e(m.brief.slice(0, 160))}</h4><p>${e(m.sourceTitle)} → ${e(m.targetTitle)}</p><details${open.has(m.id) ? ' open' : ''}><summary>Unseal briefing</summary><pre>${e(m.packet)}</pre></details></div><div class="mission-controls">${m.status === 'draft' ? `<button class="btn primary" data-office-action="deliver" data-id="${e(m.id)}">Deliver in agent app</button>` : ''}${!['done', 'cancelled'].includes(m.status) ? `<button class="btn" data-office-action="done" data-id="${e(m.id)}">Complete · +100 XP</button><button class="btn ghost" data-office-action="cancelled" data-id="${e(m.id)}">Cancel mission</button>` : ''}</div></article>`).join('') || '<div class="quest-empty">No sealed missions yet. Pick two bots and write the first brief.</div>'
  }
  renderChronicle() {
    this.panes.chronicle.innerHTML = `<h3>The office chronicle</h3><p class="usage-note">State changes observed by Agent Atrium, newest first. This is not a transcript or a reconstruction of tool calls. Up to 500 events are retained.</p><div class="chronicle-list">${(this.office.events || []).map(event => `<article class="chronicle-event ${e(event.kind)}"><i class="quest-gem"></i><div><span class="office-eyebrow">${e(event.kind.replaceAll('-', ' '))} · ${e(date(event.at))}</span><h4>${e(event.title)}</h4><p>${e(event.project || 'Office')}${event.tokens > 0 ? ` · +${formatTokens(event.tokens)} recorded tokens since the previous observation` : ''}</p>${event.threadId && this.threads.some(t => t.id === event.threadId) ? `<button class="btn ghost" data-office-action="visit" data-id="${e(event.threadId)}">Visit bot ↗</button>` : ''}</div></article>`).join('') || '<div class="quest-empty">The chronicle starts when the office observes a change. Keep the app running while your agents work.</div>'}</div>`
  }
  renderWorkshop() {
    const local = this.office.localModels || {}
    this.panes.workshop.innerHTML = `<div class="workshop-heading"><div><h3>Repo workshop</h3><p class="usage-note">Read-only Git checks. GitHub PR/CI metadata uses your installed, authenticated gh CLI when available. Local tests need a report file; they are never run automatically.</p></div><button class="btn" data-office-action="refresh">Refresh readings</button></div>
      ${this.office.healthChecking ? '<p class="usage-note">The workshop is checking repositories in the background…</p>' : ''}<div class="workshop-grid">${(this.office.health || []).map(r => `<article class="quest-card health-${e(r.status)}"><div class="health-title"><i class="quest-gem"></i><h4>${e(r.project)}</h4></div><p>${e(r.branch || 'Branch unknown')} · ${r.changedFiles ?? '?'} changed files</p><div class="health-chips"><span>Local tests: ${e(r.tests)}${r.testsStale ? ' · old report' : ''}</span><span>CI: ${e(r.checks)}</span></div>${r.pr ? `<a href="${e(r.pr.url)}" target="_blank" rel="noopener noreferrer">PR #${r.pr.number} · ${e(r.pr.state)}</a>` : '<p class="usage-note">No PR reported for this branch.</p>'}${r.commit ? `<p class="usage-note">${e(r.commit.sha)} · ${e(r.commit.title)}</p>` : ''}<small class="usage-note">Read: ${e(date(r.observedAt))}${r.testsAt ? ` · Tests: ${e(date(r.testsAt))}` : ''}</small><button class="btn ghost" data-office-action="room" data-id="${e(r.project)}">Visit room ↗</button></article>`).join('') || '<div class="quest-empty">Repository readings arrive shortly after the workshop opens.</div>'}</div>
      <h3>Local model engine room</h3><p class="usage-note">Connection probes only: no prompts, loading or inference. Ollama lists loaded models; LM Studio may list downloaded models too. Latency is the probe response time, not tokens per second.</p><div class="workshop-grid">${(local.servers || []).map(s => `<article class="quest-card health-${s.status === 'online' ? 'clear' : 'unknown'}"><div class="health-title"><i class="quest-gem"></i><h4>${e(s.name)}</h4></div><p>${e(s.status)}${s.latencyMs != null ? ` · ${s.latencyMs} ms probe` : ''}</p>${s.models?.length ? s.models.map(m => `<p>${e(m.name)}${m.vramBytes != null ? ` · ${(m.vramBytes / 1073741824).toFixed(1)} GiB VRAM` : ''}${m.contextTokens ? ` · ${formatTokens(m.contextTokens)} context` : ''}</p>`).join('') : '<p class="usage-note">No models reported. Start the local server or load a model in its own app.</p>'}</article>`).join('')}</div><h3>GPU telemetry</h3>${local.gpus?.length ? local.gpus.map(g => `<article class="quest-card"><h4>${e(g.name)}</h4><p>${g.usedMiB ?? '?'} / ${g.totalMiB ?? '?'} MiB VRAM · ${g.utilization ?? '?'}% GPU</p></article>`).join('') : '<p class="usage-note">NVIDIA telemetry unavailable. Other GPUs continue to work; their memory is not guessed.</p>'}`
  }
}
