import * as THREE from 'three'
import { MAX_HEALTH } from './damage.js'

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
  strong: { text: (n) => `-${n} FORTE!`, cls: 'mult-2' },
  smash: { text: (n) => `-${n} PANCADA!`, cls: 'mult-3' },
  turbo: { text: (n) => `-${n} TURBO!`, cls: 'turbo' },
  wall: { text: (n) => `-${n} PAREDE!`, cls: 'wall' },
  spike: { text: (n) => `-${n} ESPINHOS!`, cls: 'spike' },
  ko: { text: () => 'NOCAUTE!', cls: 'ko' },
  pickup: { text: () => '+1 BOOST', cls: 'pickup' },
}

const el = (tag, className, text) => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

// Barra de vida: verde → amarelo → vermelho
const healthColor = (ratio) => (ratio > 0.5 ? '#4cd964' : ratio > 0.25 ? '#ffd23f' : '#ff3d3d')

function healthBar(hp) {
  const bar = el('span', 'hp-bar')
  const fill = el('span', 'hp-fill')
  const ratio = Math.max(0, hp) / MAX_HEALTH
  fill.style.width = `${ratio * 100}%`
  fill.style.background = healthColor(ratio)
  bar.append(fill)
  return bar
}

export class ScoreUI {
  constructor() {
    this.board = el('div', 'scoreboard')
    this.board.append(el('h2', '', 'Vida'))
    this.list = el('ol')
    this.board.append(this.list)
    document.body.append(this.board)
    this.popups = []
    this.tmp = new THREE.Vector3()
    this.lastKey = ''
  }

  /** @param {{ name: string, color: string, hp: number, ko: boolean, isMe: boolean }[]} players */
  render(players) {
    // Mais vida em cima; nocauteados por último
    const sorted = [...players].sort((a, b) => (a.ko - b.ko) || (b.hp - a.hp))
    // Só refaz o DOM quando algo mudou (dirty check)
    const key = JSON.stringify(sorted)
    if (key === this.lastKey) return
    this.lastKey = key
    this.list.replaceChildren(...sorted.map((p) => {
      const li = el('li', `${p.isMe ? 'me' : ''} ${p.ko ? 'ko' : ''}`)
      const dot = el('span', 'dot')
      dot.style.background = p.color // montado localmente a partir de cores validadas
      li.append(dot, el('span', 'name', p.name), healthBar(p.hp), el('span', 'points', p.ko ? 'KO' : String(p.hp)))
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
    head.append(el('span', 'hp-label', 'Vida'), this.number, el('span', 'hp-max', `/ ${MAX_HEALTH}`))
    this.frame = el('div', 'hp-frame')
    this.lag = el('span', 'hp-lag')
    this.fill = el('span', 'hp-fill')
    this.frame.append(this.lag, this.fill, el('span', 'hp-ticks'))
    this.status = el('div', 'hp-status')
    this.root.append(head, this.frame, this.status)
    parent.append(this.root)
    this.hp = MAX_HEALTH
    this.fill.style.background = healthColor(1)
  }

  set(hp) {
    if (hp === this.hp) return
    const ratio = Math.max(0, hp) / MAX_HEALTH
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
    this.boostHint = el('div', 'hint', 'ESPAÇO: boost')
    this.root.append(slots, this.boostHint)
    document.body.append(this.root)
    this.lastKey = ''
  }

  render({ hp, ko, shielded, koTimer, boosts, boosting }) {
    const key = `${hp}:${ko}:${shielded}:${Math.ceil(koTimer)}:${boosts}:${boosting}`
    if (key === this.lastKey) return
    this.lastKey = key
    this.health.set(hp)
    this.health.status.textContent = ko ? `NOCAUTE · volta em ${Math.ceil(koTimer)}` : ''
    this.health.root.classList.toggle('ko', ko)
    this.health.root.classList.toggle('shielded', shielded)
    this.root.classList.toggle('boosting', boosting)
    this.slots.forEach((s, i) => s.classList.toggle('full', i < boosts))
  }
}

const NAME_HEIGHT = 3.2 // m acima do chão: por cima da haste
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
    const tag = { name: el('div', 'car-tag-name'), bar: el('div', 'car-tag-bar'), fill: el('span', 'fill'), lag: el('span', 'lag'), hp: MAX_HEALTH, text: '' }
    tag.fill.style.background = healthColor(1)
    tag.bar.append(tag.lag, tag.fill)
    this.layer.append(tag.name, tag.bar)
    this.tags.set(id, tag)
    return tag
  }

  setHp(tag, hp) {
    if (hp === tag.hp) return
    const ratio = Math.max(0, hp) / MAX_HEALTH
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
   * @param {Iterable<{ id: string, name: string, hp: number, position: THREE.Vector3, visible: boolean }>} subjects
   *   name vazio = só a barra (meu carro)
   */
  update(camera, subjects) {
    // "Para a câmera" no chão: a barra vai para a frente do carro na tela
    camera.getWorldDirection(this.ahead).setY(0).normalize().multiplyScalar(-BAR_AHEAD)
    this.seen.clear()
    for (const s of subjects) {
      this.seen.add(s.id)
      const tag = this.tags.get(s.id) ?? this.create(s.id)
      const nameAt = s.visible && s.name ? this.toScreen(this.tmp.copy(s.position).setY(NAME_HEIGHT), camera) : null
      const barAt = s.visible ? this.toScreen(this.tmp.copy(s.position).setY(0).add(this.ahead), camera) : null
      tag.name.hidden = !nameAt
      tag.bar.hidden = !barAt
      if (nameAt) {
        if (s.name !== tag.text) tag.name.textContent = tag.text = s.name
        tag.name.style.transform = `translate(${nameAt[0]}px, ${nameAt[1]}px) translate(-50%, -100%)`
      }
      if (barAt) {
        this.setHp(tag, s.hp)
        tag.bar.style.transform = `translate(${barAt[0]}px, ${barAt[1]}px) translate(-50%, 0)`
      }
    }
    // Quem saiu da sala perde a etiqueta
    for (const [id, tag] of this.tags) {
      if (this.seen.has(id)) continue
      tag.name.remove()
      tag.bar.remove()
      this.tags.delete(id)
    }
  }
}
