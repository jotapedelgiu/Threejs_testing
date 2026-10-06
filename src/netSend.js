// Economia de rede: o estado de um carro é a maior parte do tráfego (e o
// anfitrião manda o de cada bot), então cada mensagem e cada byte pesam. Aqui o
// estado cru vira o que realmente precisa ir, e só quando precisa. Sem
// dependências de navegador, para poder ser testado no Node.
//
// - Dead reckoning (deadReckoning.js): quem recebe extrapola o carro entre
//   mensagens, e quem manda roda o mesmo modelo: só manda quando ele erraria mais
//   que um limite (ou a cada DR.maxGap s). Carro em reta, parado ou fazendo uma
//   curva constante quase não manda nada.
// - Números do movimento arredondados (1 cm, ~0,06°): o JSON deixa de carregar
//   17 dígitos por número, sem diferença visível.
// - Campos lentos (cores, placar, XP...) só vão quando mudam, a cada FULL_EVERY s
//   e quando alguém novo entra (forceFull). Quem recebe trata campo ausente
//   como "igual ao último" (protocol.js).
// - Campos com o valor padrão (false, null, 0) nem vão: o validador (protocol.js)
//   já assume esses valores quando o campo falta.

import { DR, exceedsError } from './deadReckoning.js'

export const FULL_EVERY = 3 // s

// Casas do arredondamento: valor x fator, arredondado, / fator
const MOVE = { t: 1000, x: 100, z: 100, yaw: 1000, yawRate: 1000, vx: 100, vz: 100, y: 1000, roll: 1000, pitch: 1000 }

// Mudam pouco: só vão quando mudam (ou a cada FULL_EVERY s)
const SLOW = ['colors', 'livery', 'deaths', 'koBy', 'asBy', 'xpBy', 'dmgBy', 'dmgTaken']

// Sem estes campos, quem recebe assume false / null / 0
const DEFAULTABLE = ['boosting', 'ko', 'shield', 'ghost', 'ult', 'ms', 'tp']

// Mudou algum destes: manda na hora (os outros não conseguem prever)
const DISCRETE = ['boosting', 'ko', 'shield', 'ghost', 'ult', 'ms', 'tp', 'hp']

const round = (v, factor) => Math.round(v * factor) / factor

export class StateSender {
  constructor() {
    this.reset()
  }

  reset() {
    this.last = null // o que os outros receberam por último (já arredondado)
    this.lastFull = -Infinity
    this.slowKey = null
    this.force = true
  }

  /** Alguém novo na sala: o próximo estado leva tudo, para ele não esperar FULL_EVERY s. */
  forceFull() {
    this.force = true
  }

  /**
   * @param {object} state estado completo (formato de protocol.js: state)
   * @param {number} now tempo de simulação (s)
   * @param {{ force?: boolean }} opts force: manda mesmo que o modelo de quem recebe ainda acerte
   *   (lista completa de bots)
   * @returns {{ state: object, full: boolean } | null} o que mandar (full = levou os campos
   *   lentos); null = os outros já veem o carro certo, não manda
   */
  build(state, now, { force = false } = {}) {
    const out = {}
    const slow = {}
    for (const [key, value] of Object.entries(state)) {
      if (value === undefined) continue
      if (key in MOVE) out[key] = round(value, MOVE[key])
      else if (SLOW.includes(key)) slow[key] = value
      else if (DEFAULTABLE.includes(key) && (value === false || value === null || value === 0)) continue
      else out[key] = value
    }
    const slowKey = JSON.stringify(slow)
    const full = this.force || slowKey !== this.slowKey || now - this.lastFull >= FULL_EVERY
    if (!full && !force && this.last && !this.due(out)) return null
    this.last = { ...out }
    if (full) {
      Object.assign(out, slow)
      this.slowKey = slowKey
      this.lastFull = now
      this.force = false
    }
    return { state: out, full }
  }

  /** Os outros precisam de um estado novo? (tempo máximo, erro do modelo ou campo que não se prevê) */
  due(out) {
    const last = this.last
    if (out.t - last.t >= DR.maxGap - 1e-9) return true
    if (DISCRETE.some((key) => out[key] !== last[key])) return true
    return exceedsError(last, out)
  }
}
