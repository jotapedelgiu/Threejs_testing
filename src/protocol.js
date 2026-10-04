// Protocolo da rede: formato e validação das mensagens trocadas entre os
// jogadores (ver net.js). Sem dependências de navegador, para poder ser
// testado no Node.
//
// Mensagens:
//   state  { t, x, z, yaw, vx, vz, y, roll, pitch, boosting, tp, hp, ko, shield, livery, colors, ult }
//          (ult = tipo do ultimate em uso agora, ou null; ms = mísseis disparados até agora:
//          aumentou = lançar um míssil daquele carro)
//          (tp = contador de teletransportes: mudou, não interpola)
//          estado do carrinho de quem manda, 20x por segundo (t = relógio de simulação)
//   hit    { target, ix, iz, damage, boosted, stun, zap, blast, rocket }  quem bateu: empurrão e
//                                               dano que `target` recebe (stun = s atordoado; zap =
//                                               raio da Sobrecarga; blast = Onda de choque; rocket = míssil)
//   wall   { damage }                           quem manda bateu na parede depois de um boost
//   pickup { slot, gen }                        alguém pegou uma esfera
//   layout { seed, since, orbs: [{ gen, wait }] } mapa da partida + esferas, para quem acabou de entrar
//   bat    { index, dx, dz, strength, damage }  quem manda bateu num bastão (animação + dano)
//   hello  { name, since, phase }               quem sou eu: nome, quando entrei na sala e se
//                                               estou na sala de espera ('lobby') ou jogando
//   start  { seed, since }                      o anfitrião começou a partida (mapa dela)
//   ult    { n, phase, kind, left, given }      item do ultimate no centro (só o anfitrião manda;
//                                               given = último entregue { n, owner, kind }; ultimate.js)
//   ultreq { n, op }                            pedido ao anfitrião: 'claim' (passei no centro)
//   medkit { v, zones: [{ id, x, z, left }] }   zonas de cura ativas (só o anfitrião manda; medkit.js)

// Qualquer jogador pode mandar qualquer coisa. Um NaN num empurrão quebraria a
// física de quem recebe para sempre, e um valor gigante jogaria o carro para
// fora do mapa; então tudo é conferido e limitado antes de chegar ao jogo.
// Mensagem inválida é descartada (null).
import { ULT_KINDS } from './ultimate.js'

const MAX_SPEED = 60 // m/s; bem acima de qualquer velocidade real do jogo
const MAX_COORD = 1000

const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : null)
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null)
const str = (v, maxLength) => (typeof v === 'string' && v.length <= maxLength ? v : null)
const isColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
const anyNull = (o) => Object.values(o).some((v) => v === null)
const ULT_PHASES = ['waiting', 'warning', 'available']
const ULT_OPS = ['claim']
const NAME_MAX = 16 // igual a lobby.js
const PHASES = ['lobby', 'playing']
const seedOf = (m) => {
  const seed = str(m?.seed, 64)
  const since = num(m?.since, 0, Number.MAX_SAFE_INTEGER)
  return seed && since !== null ? { seed, since } : null
}

export const validators = {
  state(m) {
    const out = {
      t: num(m?.t, 0, Infinity),
      x: num(m?.x, -MAX_COORD, MAX_COORD),
      z: num(m?.z, -MAX_COORD, MAX_COORD),
      yaw: num(m?.yaw, -1e6, 1e6),
      vx: num(m?.vx, -MAX_SPEED, MAX_SPEED),
      vz: num(m?.vz, -MAX_SPEED, MAX_SPEED),
      y: num(m?.y, 0, 20),
      roll: num(m?.roll, -Math.PI, Math.PI),
      pitch: num(m?.pitch, -Math.PI, Math.PI),
    }
    if (anyNull(out)) return null
    out.boosting = m.boosting === true
    out.tp = int(m.tp, 0, 1e9) ?? 0
    out.hp = int(m.hp, 0, 1000) ?? 0
    out.ko = m.ko === true
    out.shield = m.shield === true
    out.livery = str(m.livery, 40)
    out.colors = Array.isArray(m.colors) && m.colors.length === 2 && m.colors.every(isColor) ? m.colors : null
    out.ult = ULT_KINDS.includes(m.ult) ? m.ult : null
    out.ms = int(m.ms, 0, 1e6) ?? 0
    return out
  },
  hit(m) {
    const out = {
      target: str(m?.target, 64),
      ix: num(m?.ix, -MAX_SPEED, MAX_SPEED),
      iz: num(m?.iz, -MAX_SPEED, MAX_SPEED),
      damage: int(m?.damage, 0, 100),
    }
    if (anyNull(out)) return null
    out.boosted = m.boosted === true
    out.stun = num(m.stun, 0, 3) ?? 0
    out.zap = m.zap === true
    out.blast = m.blast === true
    out.rocket = m.rocket === true
    return out
  },
  wall(m) {
    const out = { damage: int(m?.damage, 0, 100) }
    return anyNull(out) ? null : out
  },
  pickup(m) {
    const out = { slot: int(m?.slot, 0, 63), gen: int(m?.gen, 0, 1e9) }
    return anyNull(out) ? null : out
  },
  bat(m) {
    const out = {
      index: int(m?.index, 0, 63),
      dx: num(m?.dx, -1, 1),
      dz: num(m?.dz, -1, 1),
      strength: num(m?.strength, 0, MAX_SPEED),
      damage: int(m?.damage, 0, 100),
    }
    return anyNull(out) ? null : out
  },
  layout(m) {
    const map = seedOf(m)
    if (!map || !Array.isArray(m.orbs) || m.orbs.length > 64) return null
    const orbs = m.orbs.map((o) => ({ gen: int(o?.gen, 0, 1e9), wait: num(o?.wait, 0, 60) }))
    return orbs.some(anyNull) ? null : { ...map, orbs }
  },
  hello(m) {
    // Nome chega de outro jogador: só texto, tamanho limitado, sem quebras
    const name = typeof m?.name === 'string' ? m.name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : ''
    const since = num(m?.since, 0, Number.MAX_SAFE_INTEGER)
    if (since === null || !PHASES.includes(m.phase)) return null
    return { name, since, phase: m.phase }
  },
  start: seedOf,
  ult(m) {
    const out = {
      n: int(m?.n, 0, 1e9),
      left: num(m?.left, 0, 600),
    }
    if (anyNull(out) || !ULT_PHASES.includes(m.phase)) return null
    out.phase = m.phase
    out.kind = ULT_KINDS.includes(m.kind) ? m.kind : null
    if (out.phase === 'available' && !out.kind) return null
    out.given = null
    if (m.given != null) {
      const given = { n: int(m.given.n, 0, 1e9), owner: str(m.given.owner, 64), kind: ULT_KINDS.includes(m.given.kind) ? m.given.kind : null }
      if (anyNull(given)) return null
      out.given = given
    }
    return out
  },
  medkit(m) {
    const v = int(m?.v, 0, 1e9)
    if (v === null || !Array.isArray(m.zones) || m.zones.length > 4) return null
    const zones = m.zones.map((z) => ({
      id: int(z?.id, 0, 1e9),
      x: num(z?.x, -MAX_COORD, MAX_COORD),
      z: num(z?.z, -MAX_COORD, MAX_COORD),
      left: num(z?.left, 0, 600),
    }))
    return zones.some(anyNull) ? null : { v, zones }
  },
  ultreq(m) {
    const n = int(m?.n, 0, 1e9)
    return n !== null && ULT_OPS.includes(m.op) ? { n, op: m.op } : null
  },
}

