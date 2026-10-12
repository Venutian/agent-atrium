import { statusFor } from '../game/atrium.js'

/**
 * The tab title and the desktop notifications: how a bot that needs you gets your attention
 * when the window is behind something else. Counts use the same status rules as the panel,
 * so the title never disagrees with what the panel says.
 */
export class AttentionAlerts {
  constructor({ document, Notification, onClick }) {
    this.document = document
    this.Notification = Notification
    this.onClick = onClick
    this.previous = null
  }

  update(threads, enabled, now = Date.now()) {
    const attention = threads.filter((t) => {
      const status = statusFor(t, now)
      return status === 'waiting' || status === 'blocked'
    })
    const blocked = attention.filter((t) => t.hasError).length
    const waiting = attention.length - blocked
    const parts = [waiting && `${waiting} need you`, blocked && `${blocked} blocked`].filter(Boolean)
    this.document.title = parts.length ? `(${parts.join(' · ')}) Agent Atrium` : 'Agent Atrium'
    const next = new Map(attention.map((t) => [t.id, `${t.hasError}:${t.lastActivityAt}`]))
    if (this.previous && enabled && this.document.hidden && this.Notification?.permission === 'granted') {
      const changed = attention.filter((t) => this.previous.get(t.id) !== next.get(t.id))
      if (changed.length) {
        const thread = changed[0]
        try {
          const notification = new this.Notification(changed.length > 1 ? `${changed.length} bots need you` : `${thread.project} needs you`, {
            body: `${thread.hasError ? 'Blocked' : 'Waiting on you'}: ${thread.title}`,
            tag: 'agent-atrium-attention',
          })
          notification.onclick = () => { this.onClick(thread.id); notification.close() }
        } catch { /* notification delivery can be disabled by the browser or OS */ }
      }
    }
    this.previous = next
  }
}
