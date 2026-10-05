import * as THREE from 'three'
import { MAX_HEALTH } from './damage.js'
import { standings } from './match.js'

// Interface sobre o jogo (HTML): quadro de vidas, textos de dano flutuando e o
// HUD do jogador (vida + boosts). Fica separada das regras (damage.js) para
// elas serem testáveis sem navegador.
//
// Segurança: nomes e números dos outros jogadores chegam pela rede, então nada
// aqui usa innerHTML com esses dados; o texto entra sempre por textContent.

const POPUP_DURATION = 1.1 // s
// Texto e estilo de cada tipo; `n` é o dano daquela batida
const POPUPS = {
  light: { text: (n) => `-${n}`, cls: 'mult-1' },
  strong: { text: (n) => `-${n} HEAVY!`, cls: 'mult-2' },
  smash: { text: (n) => `-${n} CRITICAL!`, cls: 'mult-3' },
  turbo: { text: (n) => `-${n} BOOST SLAM!`, cls: 'turbo' },
  wall: { text: (n) => `-${n} WALL SLAM!`, cls: 'wall' },
  spike: { text: (n) => `-${n} SPIKED!`, cls: 'spike' },
  ko: { text: () => 'K.O.!', cls: 'ko' },
  levelup: { text: (n) => `LEVEL ${n}!`, cls: 'levelup' },
  pickup: { text: () => '+1 BOOST', cls: 'pickup' },
  zap: { text: (n) => (n ? `-${n} ZAP!` : 'ZAP!'), cls: 'zap' },
  stun: { text: () => 'STUNNED!', cls: 'stun' },
  ultget: { text: () => '+ULT', cls: 'zap' },
  blast: { text: (n) => (n ? `-${n} BOOM!` : 'BOOM!'), cls: 'blast' },
  heal: { text: (n) => (n ? `+${n} HP` : '+HP'), cls: 'heal' },
  rocket: { text: (n) => (n ? `-${n} DIRECT HIT!` : 'DIRECT HIT!'), cls: 'blast' },
  slow: { text: () => 'SLOWED!', cls: 'slow' },
}

const el = (tag, className, text) => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

// Barra de vida: verde → amarelo → vermelho
const healthColor = (ratio) => (ratio > 0.5 ? '#4cd964' : ratio > 0.25 ? '#ffd23f' : '#ff3d3d')

function healthBar(hp, max) {
  const bar = el('span', 'hp-bar')
  const fill = el('span', 'hp-fill')
  const ratio = Math.max(0, hp) / max
  fill.style.width = `${ratio * 100}%`
  fill.style.background = healthColor(ratio)
  bar.append(fill)
  return bar
}

export class ScoreUI {
  constructor() {
    this.board = el('div', 'scoreboard')
    this.board.append(el('h2', '', 'Scoreboard · K / D / A'))
    this.list = el('ol')
    this.board.append(this.list)
    document.body.append(this.board)
    this.popups = []
    this.tmp = new THREE.Vector3()
    this.lastKey = ''
  }

  setVisible(open) {
    this.board.classList.toggle('open', open)
  }

  /** @param {{ name: string, color: string, hp: number, maxHp: number, level: number, ko: boolean, isMe: boolean, kills: number, assists: number, deaths: number }[]} players */
  render(players) {
    // Mais abates em cima; empate: mais assistências, depois menos mortes
    const sorted = standings(players)
    // Só refaz o DOM quando algo mudou (dirty check)
    const key = JSON.stringify(sorted)
    if (key === this.lastKey) return
    this.lastKey = key
    const head = el('li', 'head')
    head.append(el('span'), el('span', '', 'Player'), el('span', '', 'Lv'), el('span', '', 'HP'),
      el('span', '', 'K'), el('span', '', 'D'), el('span', '', 'A'), el('span', '', 'KDA'))
    this.list.replaceChildren(head, ...sorted.map((p) => {
      const li = el('li', `${p.isMe ? 'me' : ''} ${p.ko ? 'ko' : ''}`)
      const dot = el('span', 'dot')
      dot.style.background = p.color // montado localmente a partir de cores validadas
      const kda = ((p.kills + p.assists) / Math.max(1, p.deaths)).toFixed(1)
      li.append(dot, el('span', 'name', p.name), el('span', 'level', `${p.level}`), healthBar(p.hp, p.maxHp),
        el('span', 'points', String(p.kills)), el('span', 'points', String(p.deaths)), el('span', 'points', String(p.assists)), el('span', 'points', kda))
      return li
    }))
  }

  /**
   * Texto estilo quadrinhos subindo acima de um ponto do mundo.
   * @param {'light' | 'strong' | 'smash' | 'turbo' | 'wall' | 'spike' | 'ko' | 'pickup'} kind
   * @param {number} [amount] dano mostrado no texto
   */
  popup(worldPosition, kind, amount = 0) {
    const style = POPUPS[kind]
    if (!style) return
    const e = el('div', `hit-popup ${style.cls}`, style.text(amount))
    document.body.append(e)
    this.popups.push({ el: e, position: worldPosition.clone(), age: 0 })
  }

  update(dt, camera) {
    if (!this.popups.length) return
    const w = window.innerWidth, h = window.innerHeight
    let alive = 0
    for (const p of this.popups) {
      p.age += dt
      if (p.age > POPUP_DURATION) {
        p.el.remove()
        continue
      }
      // Sobe um pouco no mundo e acompanha a câmera
      this.tmp.copy(p.position)
      this.tmp.y += 3.4 + p.age * 1.5
      this.tmp.project(camera)
      p.el.style.left = `${((this.tmp.x + 1) / 2) * w}px`
      p.el.style.top = `${((1 - this.tmp.y) / 2) * h}px`
      this.popups[alive++] = p
    }
    this.popups.length = alive // remove os vencidos sem criar outro array
  }
}

/**
 * Barra de vida grande (canto inferior esquerdo), estilo jogo de luta: ao
 * tomar dano a barra cai na hora, mas um "rastro" claro fica mostrando o
 * pedaço perdido e só escorre depois de um instante (CSS: transição com
 * atraso). Batidas seguidas acumulam no mesmo rastro. A barra também treme e
 * pisca, e o dano aparece na ponta. Ao recuperar vida, ela enche devagar.
 */
class HealthBar {
  constructor(parent) {
    this.root = el('div', 'health-hud')
    const head = el('div', 'hp-head')
    this.number = el('span', 'hp-num', String(MAX_HEALTH))
    this.maxLabel = el('span', 'hp-max', `/ ${MAX_HEALTH}`)
    this.level = el('span', 'hp-level', 'LV 1')
    head.append(el('span', 'hp-label', 'HP'), this.number, this.maxLabel, this.level)
    this.xp = el('div', 'hp-xp')
    this.xpFill = el('span', 'hp-xp-fill')
    this.xp.append(this.xpFill)
    this.frame = el('div', 'hp-frame')
    this.lag = el('span', 'hp-lag')
    this.fill = el('span', 'hp-fill')
    this.frame.append(this.lag, this.fill, el('span', 'hp-ticks'))
    this.status = el('div', 'hp-status')
    this.root.append(head, this.xp, this.frame, this.status)
    parent.append(this.root)
    this.hp = MAX_HEALTH
    this.max = MAX_HEALTH
    this.fill.style.background = healthColor(1)
  }

  set(hp, max = this.max) {
    if (hp === this.hp && max === this.max) return
    if (max !== this.max) {
      this.max = max
      this.maxLabel.textContent = `/ ${max}`
    }
    const ratio = Math.max(0, hp) / max
    const width = `${ratio * 100}%`
    if (hp < this.hp) {
      // Dano: a barra cai já; o rastro espera e escorre (transição do CSS)
      this.root.classList.remove('healing')
      this.fill.style.width = width
      this.lag.style.width = width
      this.hurt(this.hp - hp)
    } else {
      // Cura (voltou do nocaute): o rastro vai junto, sem atraso; a barra enche
      this.root.classList.add('healing')
      this.lag.style.transition = 'none'
      this.lag.style.width = width
      void this.lag.offsetWidth // aplica sem animar antes de devolver a transição
      this.lag.style.transition = ''
      this.fill.style.width = width
    }
    this.fill.style.background = healthColor(ratio)
    this.number.textContent = String(Math.max(0, hp))
    this.root.classList.toggle('low', ratio <= 0.25)
    this.hp = hp
  }

  // Treme, pisca e mostra o "-N" na ponta da barra
  hurt(amount) {
    this.root.classList.remove('hit')
    void this.root.offsetWidth // reinicia a animação mesmo com batidas seguidas
    this.root.classList.add('hit')
    const tag = el('span', 'hp-damage', `-${amount}`)
    tag.style.left = this.fill.style.width
    tag.addEventListener('animationend', () => tag.remove())
    this.frame.append(tag)
  }
}

/** HUD do jogador: vida (canto inferior esquerdo) e os boosts guardados. */
export class PlayerHud {
  constructor(maxBoosts) {
    this.health = new HealthBar(document.body)

    this.root = el('div', 'player-hud')
    const slots = el('div', 'slots')
    this.slots = Array.from({ length: maxBoosts }, () => slots.appendChild(el('span', 'slot')))
    // Vaga do ultimate: guardado / pronto (E) / em uso / recarga
    this.ult = el('div', 'ult-slot')
    this.ultIcon = el('span', 'ult-icon', '⚡')
    this.ultText = el('span', 'ult-text')
    this.ult.append(this.ultIcon, this.ultText)
    slots.append(this.ult)
    this.boostHint = el('div', 'hint', 'SPACE: boost · E: ult')
    this.root.append(slots, this.boostHint)
    document.body.append(this.root)
    this.lastKey = ''
  }

  /**
   * @param {{ hp, ko, shielded, koTimer, boosts, boosting, boostLocked, missiles: number | null,
   *   ult: { stored: string | null, ready: boolean, charges: number, storedLeft: number, active: string | null, activeLeft: number, cooldown: number } }} s
   *   ult.stored/active = nome do ultimate guardado / em uso; storedLeft = s até perder o guardado;
   *   missiles = com o Míssil na mão, quantos restam (as bolinhas de boost viram mísseis)
   */
  render({ hp, maxHp, level, levelProgress = 0, ko, shielded, koTimer, boosts, boosting, boostLocked, missiles = null, ult }) {
    const ultKey = `${ult.stored}:${ult.ready}:${ult.charges}:${Math.ceil(ult.storedLeft)}:${ult.active}:${Math.ceil(ult.activeLeft)}:${Math.ceil(ult.cooldown)}`
    const key = `${hp}:${maxHp}:${level}:${Math.round(levelProgress * 200)}:${ko}:${shielded}:${Math.ceil(koTimer)}:${boosts}:${boosting}:${boostLocked}:${missiles}:${ultKey}`
    if (key === this.lastKey) return
    this.lastKey = key
    this.health.set(hp, maxHp)
    this.health.xpFill.style.width = `${levelProgress * 100}%`
    if (level !== this.health.levelShown) {
      // Subiu: o selo pulsa (a animação recomeça)
      const up = this.health.levelShown !== undefined && level > this.health.levelShown
      this.health.levelShown = level
      this.health.level.textContent = `LV ${level}`
      this.health.level.classList.remove('up')
      if (up) {
        void this.health.level.offsetWidth
        this.health.level.classList.add('up')
      }
    }
    this.health.status.textContent = ko ? `KNOCKED OUT · respawn in ${Math.ceil(koTimer)}` : ''
    this.health.root.classList.toggle('ko', ko)
    this.health.root.classList.toggle('shielded', shielded)
    this.root.classList.toggle('boosting', boosting)
    // Míssil na mão: as bolinhas de boost viram os mísseis que restam
    const missileMode = missiles !== null
    this.root.classList.toggle('missile-mode', missileMode)
    // Outro ultimate na mão: boost travado
    this.root.classList.toggle('boost-locked', boostLocked && !missileMode)
    this.boostHint.textContent = missileMode
      ? `E: fire missile (${missiles} left)`
      : boostLocked ? (ult.stored ? 'BOOST LOCKED: use your ult (E)' : 'BOOST LOCKED') : 'SPACE: boost · E: ult'
    this.slots.forEach((s, i) => s.classList.toggle('full', i < (missileMode ? missiles : boosts)))
    this.renderUlt(ult)
  }

  renderUlt({ stored, ready, charges, storedLeft, active, activeLeft, cooldown }) {
    const wait = Math.ceil(cooldown)
    const expires = Math.ceil(storedLeft)
    const name = stored && charges > 1 ? `${stored} ×${charges}` : stored
    let text, state
    if (active && !stored) {
      text = `${active} · ${Math.ceil(activeLeft)}s`
      state = 'active'
    } else if (stored && !ready && wait > 0 && !active) {
      text = `${name} · ready in ${wait}s`
      state = 'stored'
    } else if (stored) {
      text = `${name} · E · ${expires}s`
      state = 'ready'
    } else if (wait > 0) {
      text = `cooldown ${wait}s`
      state = 'empty'
    } else {
      text = 'no ult'
      state = 'empty'
    }
    this.ultText.textContent = text
    this.ult.className = `ult-slot ${state}`
    // Últimos 10 s para usar: pisca em vermelho
    this.ult.classList.toggle('expiring', !!stored && !active && expires <= 10)
  }
}

const BAR_AHEAD = 1.9   // m do centro do carro na direção da câmera: fica logo abaixo dele na tela

/**
 * Etiquetas presas aos carros: nome flutuando em cima e uma barrinha de vida
 * embaixo (com o mesmo "rastro" de dano da barra grande). HTML por cima do
 * canvas, reposicionado a cada quadro pela projeção da câmera.
 */
export class CarTags {
  constructor() {
    this.layer = el('div', 'car-tags')
    document.body.append(this.layer)
    this.tags = new Map() // id -> { name, bar, fill, lag, hp, text }
    this.seen = new Set()
    this.tmp = new THREE.Vector3()
    this.ahead = new THREE.Vector3()
  }

  create(id) {
    const tag = { name: el('div', 'car-tag-name'), bar: el('div', 'car-tag-bar'), frame: el('div', 'car-tag-frame'), num: el('span', 'car-tag-num', String(MAX_HEALTH)), fill: el('span', 'fill'), lag: el('span', 'lag'), hp: MAX_HEALTH, max: MAX_HEALTH, text: '' }
    tag.fill.style.background = healthColor(1)
    tag.frame.append(tag.lag, tag.fill, el('span', 'ticks'))
    tag.bar.append(tag.name, tag.frame, tag.num)
    this.layer.append(tag.bar)
    this.tags.set(id, tag)
    return tag
  }

  setHp(tag, hp, max) {
    if (hp === tag.hp && max === tag.max) return
    tag.max = max
    const ratio = Math.max(0, hp) / max
    const width = `${ratio * 100}%`
    if (hp > tag.hp) {
      // Cura: o rastro vai junto, sem esperar
      tag.lag.style.transition = 'none'
      tag.lag.style.width = width
      void tag.lag.offsetWidth
      tag.lag.style.transition = ''
    } else {
      tag.lag.style.width = width
    }
    tag.fill.style.width = width
    tag.fill.style.background = healthColor(ratio)
    tag.num.textContent = String(Math.max(0, hp))
    tag.num.classList.toggle('low', ratio <= 0.25)
    tag.hp = hp
  }

  // Ponto do mundo → pixels da tela; null se estiver atrás da câmera
  toScreen(point, camera) {
    const p = this.tmp.copy(point).project(camera)
    if (p.z > 1) return null
    return [((p.x + 1) / 2) * window.innerWidth, ((1 - p.y) / 2) * window.innerHeight]
  }

  /**
   * @param {THREE.Camera} camera
   * @param {Iterable<{ id: string, name: string, hp: number, maxHp: number, position: THREE.Vector3, visible: boolean, powered: boolean }>} subjects
   *   powered = está com o ultimate (nome destacado)
   *   name vazio = só a barra (meu carro)
   */
  update(camera, subjects) {
    // "Para a câmera" no chão: a barra vai para a frente do carro na tela
    camera.getWorldDirection(this.ahead).setY(0).normalize().multiplyScalar(-BAR_AHEAD)
    this.seen.clear()
    for (const s of subjects) {
      this.seen.add(s.id)
      const tag = this.tags.get(s.id) ?? this.create(s.id)
      const barAt = s.visible ? this.toScreen(this.tmp.copy(s.position).setY(0).add(this.ahead), camera) : null
      tag.name.hidden = !s.name
      tag.bar.hidden = !barAt
      if (s.powered !== tag.powered) {
        tag.powered = s.powered
        tag.name.classList.toggle('powered', s.powered)
      }
      if (barAt) {
        if (s.name !== tag.text) tag.name.textContent = tag.text = s.name
        this.setHp(tag, s.hp, s.maxHp)
        tag.bar.style.transform = `translate(${barAt[0]}px, ${barAt[1]}px) translate(-50%, 0)`
      }
    }
    // Quem saiu da sala perde a etiqueta
    for (const [id, tag] of this.tags) {
      if (this.seen.has(id)) continue
      tag.bar.remove()
      this.tags.delete(id)
    }
  }
}

const ARROW_MARGIN = 46   // px entre a seta e a borda da tela
const ARROW_RANGE = 60    // m: além disso o item não ganha seta
const ARROW_KINDS = {
  boost: '#3fb6ff',
  ultimate: '#ffd23f',
}

/**
 * Setas na borda da tela apontando para itens que estão fora da vista:
 * azul para boost, amarela para ultimate. Itens que já aparecem na tela não
 * ganham seta; as mais distantes ficam mais apagadas.
 */
export class ItemArrows {
  constructor() {
    this.layer = el('div', 'item-arrows')
    document.body.append(this.layer)
    this.pool = []
    this.tmp = new THREE.Vector3()
  }

  arrow(i) {
    if (!this.pool[i]) {
      const arrow = el('div', 'item-arrow')
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '-12 -12 24 24')
      svg.classList.add('tip')
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
      shape.setAttribute('points', '-7,-8 9,0 -7,8 -3,0')
      svg.append(shape)
      arrow.append(svg)
      this.layer.append(arrow)
      this.pool[i] = { root: arrow, kind: '' }
    }
    return this.pool[i]
  }

  /**
   * @param {THREE.Camera} camera
   * @param {THREE.Vector3} from  de onde medir a distância (meu carro)
   * @param {Iterable<{ kind: keyof typeof ARROW_KINDS, position: THREE.Vector3 }>} items
   */
  update(camera, from, items) {
    const w = window.innerWidth
    const h = window.innerHeight
    const cx = w / 2
    const cy = h / 2
    let used = 0
    for (const item of items) {
      const dist = Math.hypot(item.position.x - from.x, item.position.z - from.z)
      if (dist > ARROW_RANGE) continue
      const p = this.tmp.copy(item.position).project(camera)
      let dx = (p.x * w) / 2
      let dy = (-p.y * h) / 2
      // Atrás da câmera a projeção inverte: espelha para apontar para o lado certo
      if (p.z > 1) { dx = -dx; dy = -dy }
      const onScreen = p.z <= 1 && Math.abs(dx) < cx - ARROW_MARGIN && Math.abs(dy) < cy - ARROW_MARGIN
      if (onScreen) continue
      if (dx === 0 && dy === 0) dy = 1
      // Encosta na borda: escala o vetor até tocar o retângulo menos a margem
      const k = Math.min((cx - ARROW_MARGIN) / Math.abs(dx || 1e-6), (cy - ARROW_MARGIN) / Math.abs(dy || 1e-6))
      const x = cx + dx * k
      const y = cy + dy * k
      const a = this.arrow(used++)
      if (a.kind !== item.kind) {
        a.kind = item.kind
        a.root.style.setProperty('--arrow', ARROW_KINDS[item.kind])
      }
      a.root.hidden = false
      a.root.style.opacity = (1 - 0.55 * (dist / ARROW_RANGE)).toFixed(2)
      a.root.style.transform = `translate(${x}px, ${y}px) rotate(${Math.atan2(dy, dx)}rad)`
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].root.hidden = true
  }

  hide() {
    for (const a of this.pool) a.root.hidden = true
  }
}

/**
 * Faixa do ultimate no topo da tela: contagem do aviso, "no centro!", quem
 * pegou e quanto tempo falta. Só mexe no DOM quando o texto muda.
 */
export class UltimateBanner {
  constructor() {
    this.root = el('div', 'ult-banner')
    this.title = el('div', 'ult-title')
    this.sub = el('div', 'ult-sub')
    this.root.append(this.title, this.sub)
    this.root.hidden = true
    document.body.append(this.root)
    this.key = ''
  }

  /** @param {{ title: string, sub?: string, tone?: 'warn' | 'go' | 'mine' | 'enemy' | 'heal' | 'levelup' } | null} info */
  show(info) {
    const key = info ? `${info.title}|${info.sub ?? ''}|${info.tone ?? ''}` : ''
    if (key === this.key) return
    const appearing = !this.key && key
    this.key = key
    this.root.hidden = !info
    if (!info) return
    this.title.textContent = info.title
    this.sub.textContent = info.sub ?? ''
    this.root.className = `ult-banner ${info.tone ?? ''}`
    if (appearing) {
      this.root.style.animation = 'none'
      void this.root.offsetWidth
      this.root.style.animation = ''
    }
  }
}

/** Relógio da partida (topo da tela); nos últimos 30 s pulsa em vermelho. */
export class MatchClock {
  constructor() {
    this.root = el('div', 'match-clock')
    this.root.hidden = true
    document.body.append(this.root)
    this.text = ''
  }

  /** @param {string | null} text "4:59", ou null para esconder */
  show(text, urgent = false) {
    this.root.hidden = text === null
    if (text === null || text === this.text) return
    this.text = text
    this.root.textContent = text
    this.root.classList.toggle('urgent', urgent)
  }
}

const FEED_TIME = 4 // s que cada linha fica

/** Kill feed: "Ana ⚔ Beto" no canto, some sozinho. */
export class KillFeed {
  constructor() {
    this.root = el('div', 'kill-feed')
    document.body.append(this.root)
  }

  add(killer, victim, mine = false) {
    const row = el('div', mine ? 'kill mine' : 'kill')
    row.append(el('span', 'killer', killer), el('span', 'icon', ' ⚔ '), el('span', 'victim', victim))
    this.root.prepend(row)
    while (this.root.children.length > 5) this.root.lastChild.remove()
    setTimeout(() => row.remove(), FEED_TIME * 1000)
  }
}
