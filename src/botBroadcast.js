// Envio dos bots do anfitrião para a sala (BotBroadcaster) e o lado de quem recebe (applyBotList). Cada bot tem o seu StateSender
// (netSend.js: só manda quando o modelo de extrapolação erraria), e a lista vai
// numa mensagem só:
// - parcial (quase sempre): só os bots que mudaram, em binário (netPack.js);
// - completa (a cada BOTS_COMPLETE_EVERY s, quando o conjunto de bots muda, ou
//   quando alguém entra): todos os bots, e quem não está nela saiu.
// Nome e tipo do bot só vão junto dos campos lentos (estado "full"), então a
// lista que os leva vai em JSON. Sem dependências de navegador, para poder ser
// testado no Node.

import { StateSender } from './netSend.js'
import { packBots } from './netPack.js'

export const BOTS_COMPLETE_EVERY = 0.5 // s

/**
 * Aplica a lista de bots recebida do anfitrião (protocol.js: validators.bots).
 * @param {Map<string, { name: string, kind: string }>} known bots que já conheço (alterado aqui)
 * @param {{ id: string, name: string | null, kind: string | null, state: object }[]} list
 * @param {boolean} complete a lista tem todos os bots: quem não está nela saiu
 * @returns {{ removed: string[], updates: { id: string, state: object }[] }} quem sumiu e os estados a aplicar
 */
export function applyBotList(known, list, complete) {
  const removed = []
  if (complete) {
    const ids = new Set(list.map((b) => b.id))
    for (const id of known.keys()) {
      if (ids.has(id)) continue
      known.delete(id)
      removed.push(id)
    }
  }
  const updates = []
  for (const { id, name, kind, state } of list) {
    // Nome e tipo só vêm de tempos em tempos; sem eles, vale o que já sei (e
    // espero o primeiro envio completo, que os traz)
    if (kind) known.set(id, { name, kind })
    if (known.has(id)) updates.push({ id, state })
  }
  return { removed, updates }
}

export class BotBroadcaster {
  constructor() {
    this.senders = new Map() // id do bot -> StateSender
    this.completeAt = -Infinity // quando mandei a última lista completa
    this.idsKey = '' // quais bots ela tinha
  }

  /** Alguém novo na sala: ele recebe todos os bots (com nome e tipo) já no próximo envio. */
  forceFull() {
    for (const sender of this.senders.values()) sender.forceFull()
    this.completeAt = -Infinity
  }

  /**
   * @param {{ id: string, name: string, kind: string, state: object }[]} bots estado completo de cada bot
   * @param {number} now tempo de simulação (s)
   * @returns {{ packed: ArrayBuffer } | { message: { list: object[], complete: boolean } } | null}
   *   o que mandar (binário ou JSON); null = ninguém precisa de nada agora
   */
  build(bots, now) {
    const idsKey = bots.map((b) => b.id).join()
    const complete = now - this.completeAt >= BOTS_COMPLETE_EVERY || idsKey !== this.idsKey
    const list = []
    for (const bot of bots) {
      const sender = this.senders.get(bot.id) ?? this.senders.set(bot.id, new StateSender()).get(bot.id)
      const built = sender.build(bot.state, now, { force: complete })
      if (!built) continue
      list.push(built.full ? { id: bot.id, name: bot.name, kind: bot.kind, state: built.state } : { id: bot.id, state: built.state })
    }
    const alive = new Set(bots.map((b) => b.id))
    for (const id of this.senders.keys()) if (!alive.has(id)) this.senders.delete(id)
    if (complete) {
      this.completeAt = now
      this.idsKey = idsKey
    } else if (!list.length) return null
    // Tudo enxuto (quase sempre): uma mensagem binária só; senão, a lista em JSON
    const packed = list.every((b) => !b.kind) ? packBots(list, complete) : null
    return packed ? { packed } : { message: { list, complete } }
  }
}
