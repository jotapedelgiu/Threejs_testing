import * as THREE from 'three'
import { BOOST_HIT_DAMAGE, WALL_DAMAGE, MAX_HEALTH } from './damage.js'

// Interface sobre o jogo (HTML): quadro de vidas, textos de dano flutuando e o
// HUD do jogador (vida + boosts). Fica separada das regras (damage.js) para
// elas serem testáveis sem navegador.
//
// Segurança: nomes e números dos outros jogadores chegam pela rede, então nada
// aqui usa innerHTML com esses dados; o texto entra sempre por textContent.

const POPUP_DURATION = 1.1 // s
const POPUPS = {
  1: { text: '-1', cls: 'mult-1' },
  2: { text: '-2 FORTE!', cls: 'mult-2' },
  3: { text: '-3 PANCADA!', cls: 'mult-3' },
  turbo: { text: `-${BOOST_HIT_DAMAGE} TURBO!`, cls: 'turbo' },
  wall: { text: `-${WALL_DAMAGE} PAREDE!`, cls: 'wall' },
  ko: { text: 'NOCAUTE!', cls: 'ko' },
  pickup: { text: '+1 BOOST', cls: 'pickup' },
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
   * @param {1 | 2 | 3 | 'turbo' | 'wall' | 'ko' | 'pickup'} kind
   */
  popup(worldPosition, kind) {
    const style = POPUPS[kind]
    if (!style) return
    const e = el('div', `hit-popup ${style.cls}`, style.text)
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

/** HUD do jogador: barra de vida grande e os boosts guardados. */
export class PlayerHud {
  constructor(maxBoosts) {
    this.root = el('div', 'player-hud')

    const health = el('div', 'health')
    this.healthFill = el('span', 'hp-fill')
    const bar = el('span', 'hp-bar big')
    bar.append(this.healthFill)
    this.healthText = el('span', 'hp-text')
    health.append(bar, this.healthText)

    const slots = el('div', 'slots')
    this.slots = Array.from({ length: maxBoosts }, () => slots.appendChild(el('span', 'slot')))
    this.boostHint = el('div', 'hint', 'ESPAÇO: boost')

    this.root.append(health, slots, this.boostHint)
    document.body.append(this.root)
    this.lastKey = ''
  }

  render({ hp, ko, shielded, koTimer, boosts, boosting }) {
    const key = `${hp}:${ko}:${shielded}:${Math.ceil(koTimer)}:${boosts}:${boosting}`
    if (key === this.lastKey) return
    this.lastKey = key
    const ratio = hp / MAX_HEALTH
    this.healthFill.style.width = `${ratio * 100}%`
    this.healthFill.style.background = healthColor(ratio)
    this.healthText.textContent = ko ? `NOCAUTE · volta em ${Math.ceil(koTimer)}` : `${hp} / ${MAX_HEALTH}`
    this.root.classList.toggle('ko', ko)
    this.root.classList.toggle('shielded', shielded)
    this.root.classList.toggle('boosting', boosting)
    this.slots.forEach((s, i) => s.classList.toggle('full', i < boosts))
  }
}
