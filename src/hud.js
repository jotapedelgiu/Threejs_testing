import * as THREE from 'three'
import { BOOST_HIT_POINTS, WALL_BONUS_POINTS } from './score.js'

// Interface sobre o jogo (HTML): placar, textos "+N" flutuando e inventário de
// boost. Fica separada das regras (score.js) para elas serem testáveis sem
// navegador.
//
// Segurança: nomes e pontos dos outros jogadores chegam pela rede, então nada
// aqui usa innerHTML com esses dados; o texto entra sempre por textContent.

const POPUP_DURATION = 1.1 // s
const POPUPS = {
  1: { text: '+1', cls: 'mult-1' },
  2: { text: '+2 FORTE!', cls: 'mult-2' },
  3: { text: '+3 PANCADA!', cls: 'mult-3' },
  turbo: { text: `+${BOOST_HIT_POINTS} TURBO!`, cls: 'turbo' },
  wall: { text: `+${WALL_BONUS_POINTS} PAREDE!`, cls: 'wall' },
  pickup: { text: '+1 BOOST', cls: 'pickup' },
}

const el = (tag, className, text) => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

export class ScoreUI {
  constructor() {
    this.board = el('div', 'scoreboard')
    this.board.append(el('h2', '', 'Placar'))
    this.list = el('ol')
    this.board.append(this.list)
    document.body.append(this.board)
    this.popups = []
    this.tmp = new THREE.Vector3()
    this.lastKey = ''
  }

  /** @param {{ name: string, color: string, score: number, isMe: boolean }[]} players */
  render(players) {
    const sorted = [...players].sort((a, b) => b.score - a.score)
    // Só refaz o DOM quando algo mudou (dirty check)
    const key = JSON.stringify(sorted)
    if (key === this.lastKey) return
    this.lastKey = key
    this.list.replaceChildren(...sorted.map((p) => {
      const li = el('li', p.isMe ? 'me' : '')
      const dot = el('span', 'dot')
      dot.style.background = p.color // montado localmente a partir de cores validadas
      li.append(dot, el('span', 'name', p.name), el('span', 'points', String(p.score)))
      return li
    }))
  }

  /**
   * Texto estilo quadrinhos subindo acima de um ponto do mundo.
   * @param {1 | 2 | 3 | 'turbo' | 'wall' | 'pickup'} kind
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

export class BoostHud {
  constructor(max) {
    this.root = el('div', 'boost-hud')
    const slots = el('div', 'slots')
    this.slots = Array.from({ length: max }, () => slots.appendChild(el('span', 'slot')))
    this.root.append(slots, el('div', 'hint', 'ESPAÇO: boost'))
    document.body.append(this.root)
    this.lastKey = ''
  }

  render(count, active) {
    const key = `${count}:${active}`
    if (key === this.lastKey) return
    this.lastKey = key
    this.slots.forEach((s, i) => s.classList.toggle('full', i < count))
    this.root.classList.toggle('active', active)
  }
}
