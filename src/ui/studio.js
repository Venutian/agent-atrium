import './studio.css'

/**
 * The office as a studio, for a machine that runs a Paperclip crew.
 *
 * Three things on top of the map, all plain DOM like the rest of the HUD: a manager's panel that
 * says what the crew is doing and what is wrong, a name over each bot of the crew, and a drawer
 * to talk to the one you clicked. Nothing here exists until the server says the studio is on.
 *
 * Every list is rebuilt only when what it shows has changed: the panel sits over a render loop,
 * and a poll that brings the same answer must cost one string comparison, not a layout.
 */

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

async function call(url, payload) {
  const res = await fetch(url, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : undefined)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`)
  return body
}

export const fetchStudio = () => call('/api/studio')

function since(at, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / 1440)} d`
}

const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const BOT_STATE = { running: 'Working', idle: 'Free', paused: 'Paused', error: 'Stopped on an error' }
const STEP_NAMES = ['Build', 'Check', "Tony's ruling", 'Merge', 'Push']
const CHAT_MS = 4000
const SHOWN_LINES = 12
const SHOWN_FEED = 10

const TEMPLATE = `
<aside class="studio-panel panel">
  <header>
    <div class="studio-head">
      <strong>Studio</strong>
      <button class="btn icon ghost" data-act="fold" title="Fold this panel" aria-expanded="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>
      </button>
    </div>
    <p class="studio-state"></p>
  </header>
  <div class="studio-body">
    <section data-part="trouble"></section>
    <section data-part="crew"></section>
    <section data-part="lines"></section>
    <section data-part="feed"></section>
  </div>
</aside>
<div class="studio-tags" aria-hidden="true"></div>
<aside class="studio-chat panel" hidden>
  <header>
    <i class="light"></i>
    <div class="who"><strong></strong><span></span></div>
    <button class="btn ghost" data-act="pause"></button>
    <button class="btn icon ghost" data-act="close" title="Close (Esc)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>
  </header>
  <p class="doing"></p>
  <div class="talk" tabindex="0"></div>
  <form>
    <textarea rows="2" maxlength="4000" placeholder="Write to this bot"></textarea>
    <button class="btn primary" type="submit">Send</button>
  </form>
</aside>`

export class Studio {
  /**
   * @param {HTMLElement} root the HUD layer
   * @param {{ pickBot: (botId: string) => void, pickJob: (ref: string) => boolean, closed: () => void, refresh: () => void, toast: (text: string, kind?: string) => void }} actions
   */
  constructor(root, actions) {
    this.root = root
    this.actions = actions
    this.on = false
    this.view = null
    this.chatBot = null
    this._last = {}
    this._tags = new Map()
    this._chatTimer = 0
    this._chatSeq = 0
  }

  /** Put the studio's panels on the page. Called once, when the server first says it is on. */
  mount() {
    if (this.on) return
    this.on = true
    this.root.classList.add('studio')
    this.root.insertAdjacentHTML('beforeend', TEMPLATE)
    this.panel = this.root.querySelector('.studio-panel')
    this.tagLayer = this.root.querySelector('.studio-tags')
    // Under every panel: a name belongs to the floor, and must not be drawn across a list.
    this.root.prepend(this.tagLayer)
    this.chat = this.root.querySelector('.studio-chat')
    this.talk = this.chat.querySelector('.talk')
    this.input = this.chat.querySelector('textarea')
    // Rooms are projects here, so the office's own words for them follow.
    const brand = this.root.querySelector('.brand span')
    if (brand) brand.textContent = 'Studio'
    const back = this.root.querySelector('#btn-close-project')
    if (back) back.lastChild.textContent = ' All projects'

    this.panel.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act],[data-bot],[data-job]')
      if (!el) return
      if (el.dataset.act === 'fold') return this.fold()
      if (el.dataset.job && this.actions.pickJob(el.dataset.job)) return
      if (el.dataset.bot) this.actions.pickBot(el.dataset.bot)
    })
    this.chat.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act
      if (act === 'close') this.actions.closed()
      if (act === 'pause') this.pause()
    })
    this.chat.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); this.send() })
    this.input.addEventListener('keydown', (e) => {
      // The map's own keys (R, A, H…) must not fire while a message is being written.
      e.stopPropagation()
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send() }
      if (e.key === 'Escape') this.actions.closed()
    })
    try { if (localStorage.getItem('agentatrium.studio-folded') === '1') this.fold(true) } catch { /* private mode */ }
  }

  fold(force) {
    const folded = force ?? !this.panel.classList.contains('folded')
    this.panel.classList.toggle('folded', folded)
    this.root.classList.toggle('studio-folded', folded)
    this.panel.querySelector('[data-act="fold"]').setAttribute('aria-expanded', String(!folded))
    try { localStorage.setItem('agentatrium.studio-folded', folded ? '1' : '0') } catch { /* private mode */ }
  }

  /** Write `html` into a part of the page only if it differs from what is there. */
  _put(key, el, html) {
    if (this._last[key] === html) return
    this._last[key] = html
    el.innerHTML = html
  }

  /** The newest answer of `/api/studio`. */
  setView(view) {
    this.view = view
    const m = view.manager
    const part = (name) => this.panel.querySelector(`[data-part="${name}"]`)
    this._put('state', this.panel.querySelector('.studio-state'), esc(m.state))

    this._put('trouble', part('trouble'), m.trouble.length
      ? `<h3>Needs a look</h3>${m.trouble.map((t) => `<p class="trouble ${esc(t.level)}"><i></i>${esc(t.text)}</p>`).join('')}`
      : '')

    const crew = [...m.bots].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'))
    this._put('crew', part('crew'), `<h3>Crew</h3>${crew.map((b) => {
      const doing = b.job ? `${b.job.ref} ${b.job.title}` : b.why || (b.last ? `Last on ${b.last.ref}` : 'Nothing given yet')
      return `<button class="bot ${esc(b.status)}" data-bot="${esc(b.id)}">
        <i class="light"></i>
        <span class="name">${esc(b.name)}</span><span class="model">${esc(b.model || '')}</span>
        <span class="doing">${b.job ? `<b>${esc(b.job.stage)}</b> ` : ''}${esc(doing)}</span>
      </button>`
    }).join('')}`)

    const lines = m.lines.filter((l) => l.open).slice(0, SHOWN_LINES)
    this._put('lines', part('lines'), lines.length
      ? `<h3>Work in hand</h3>${lines.map((l) => `<button class="line ${l.late ? 'late' : ''}" data-job="${esc(l.ref)}" data-bot="${esc(m.bots.find((b) => b.name === l.bot)?.id || '')}">
        <span class="ref">${esc(l.ref)}</span><span class="title">${esc(l.title)}</span>
        <span class="steps">${l.steps.map((s, i) => `<i class="${esc(s)}" title="${STEP_NAMES[i]}: ${esc(s)}"></i>`).join('')}</span>
        <span class="note">${esc(l.bot ? `${l.bot}: ` : '')}${esc(l.note || l.stage)}</span>
      </button>`).join('')}`
      : '<h3>Work in hand</h3><p class="none">No open jobs. Tell a bot what to do: click it on the map.</p>')

    this._put('feed', part('feed'), m.feed.length
      ? `<h3>Lately</h3>${m.feed.slice(0, SHOWN_FEED).map((f) => `<p class="event ${esc(f.kind)}"><time>${clock(f.at)}</time>${esc(f.text)}</p>`).join('')}`
      : '')

    if (this.chatBot) this._syncChatHead()
  }

  // ── names over the crew ──────────────────────────────────────────────────────────

  /**
   * Called every frame with the agents and a way to find one on screen. A name sits under its
   * bot's feet, where the status badge over its head never covers it. Ten transforms
   * a frame, written only when a tag has moved a whole pixel.
   */
  placeTags(agents, screenOf) {
    if (!this.on) return
    const seen = new Set()
    for (const agent of agents) {
      const crew = agent.thread?.crew
      if (!crew || agent.state === 'gone') continue
      seen.add(agent.id)
      let tag = this._tags.get(agent.id)
      if (!tag) {
        tag = { el: document.createElement('span'), x: -1, y: -1, text: '', shown: true }
        this.tagLayer.appendChild(tag.el)
        this._tags.set(agent.id, tag)
      }
      const text = `${crew.status}|${crew.name}`
      if (tag.text !== text) {
        tag.text = text
        tag.el.className = `tag ${crew.status}`
        tag.el.textContent = crew.name
      }
      const at = agent.scale > 0.4 ? screenOf(agent, -0.12) : null
      if (!at) {
        if (tag.shown) { tag.shown = false; tag.el.style.display = 'none' }
        continue
      }
      const x = Math.round(at.x), y = Math.round(at.y)
      if (!tag.shown) { tag.shown = true; tag.el.style.display = '' }
      if (x !== tag.x || y !== tag.y) {
        tag.x = x; tag.y = y
        tag.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, 0)`
      }
    }
    for (const [id, tag] of this._tags) {
      if (seen.has(id)) continue
      tag.el.remove()
      this._tags.delete(id)
    }
  }

  // ── talking to a bot ─────────────────────────────────────────────────────────────

  _bot(id = this.chatBot) {
    return this.view?.manager.bots.find((b) => b.id === id) || null
  }

  _syncChatHead() {
    const bot = this._bot()
    if (!bot) return
    const paused = bot.status === 'paused'
    this._put('chat-head', this.chat.querySelector('.who'), `<strong>${esc(bot.name)}</strong><span>${esc([bot.title, bot.model].filter(Boolean).join(', '))}</span>`)
    this.chat.querySelector('header').className = bot.status
    const button = this.chat.querySelector('[data-act="pause"]')
    button.textContent = paused ? 'Resume' : 'Pause'
    const doing = bot.job
      ? `${bot.job.stage} ${bot.job.ref} ${bot.job.title}${bot.job.minutes ? `, ${bot.job.minutes} min in` : ''}`
      : bot.why || `${BOT_STATE[bot.status] || bot.status}${bot.last ? `. Last on ${bot.last.ref} ${bot.last.title}, ${since(bot.last.at)} ago` : ''}`
    this._put('chat-doing', this.chat.querySelector('.doing'), esc(doing))
  }

  /** Open the drawer on one bot of the crew. */
  openChat(botId) {
    if (!this.on) return
    if (this.chatBot !== botId) {
      this.chatBot = botId
      this._last.talk = null
      this.talk.innerHTML = '<p class="none">Reading the conversation…</p>'
      this.input.value = ''
    }
    this.chat.hidden = false
    this.root.classList.add('studio-chatting')
    this._syncChatHead()
    this._loadChat()
  }

  focus() {
    this.input.focus()
  }

  closeChat() {
    if (!this.chatBot) return
    this.chatBot = null
    this.chat.hidden = true
    this.root.classList.remove('studio-chatting')
    clearTimeout(this._chatTimer)
  }

  async _loadChat() {
    clearTimeout(this._chatTimer)
    const bot = this.chatBot
    if (!bot) return
    const seq = ++this._chatSeq
    try {
      const chat = await call(`/api/studio/chat?bot=${encodeURIComponent(bot)}`)
      if (seq !== this._chatSeq || bot !== this.chatBot) return
      const html = chat.messages.length
        ? chat.messages.map((m) => `<div class="msg ${m.mine ? 'mine' : ''}"><span class="from">${esc(m.mine ? 'You' : m.from)} <time>${clock(m.at)}</time></span><p>${esc(m.text)}</p></div>`).join('')
          + (chat.working ? '<p class="typing">Writing an answer…</p>' : '')
        : '<p class="none">Nothing said yet. Write what you want done; the bot answers here.</p>'
      if (this._last.talk !== html) {
        // Stay at the bottom only if the reader was already there: scrolling back is reading.
        const pinned = this.talk.scrollHeight - this.talk.scrollTop - this.talk.clientHeight < 40 || this._last.talk == null
        this._last.talk = html
        this.talk.innerHTML = html
        if (pinned) this.talk.scrollTop = this.talk.scrollHeight
      }
    } catch (err) {
      if (seq === this._chatSeq && this._last.talk == null) this.talk.innerHTML = `<p class="none">${esc(err.message)}</p>`
    }
    // A hidden page asks nothing; `wake` picks the conversation up again.
    if (bot === this.chatBot && !document.hidden) this._chatTimer = setTimeout(() => this._loadChat(), CHAT_MS)
  }

  /** The page came back into view. */
  wake() {
    if (this.chatBot) this._loadChat()
  }

  async send() {
    const text = this.input.value.trim()
    if (!text || !this.chatBot || this._sending) return
    this._sending = true
    this.chat.classList.add('sending')
    try {
      await call('/api/studio/chat', { bot: this.chatBot, text })
      this.input.value = ''
      await this._loadChat()
      this.talk.scrollTop = this.talk.scrollHeight
    } catch (err) {
      this.actions.toast(err.message || 'The message did not go', 'err')
    } finally {
      this._sending = false
      this.chat.classList.remove('sending')
    }
  }

  async pause() {
    const bot = this._bot()
    if (!bot) return
    const action = bot.status === 'paused' ? 'resume' : 'pause'
    try {
      await call('/api/studio/bot', { bot: bot.id, action })
      this.actions.toast(action === 'pause' ? `${bot.name} is paused` : `${bot.name} is back at work`)
      this.actions.refresh()
    } catch (err) {
      this.actions.toast(err.message || 'That did not work', 'err')
    }
  }
}
