import * as THREE from 'three'

// Pontuação: regra das batidas + interface (placar e "+N" flutuando).
//
// Regra: toda batida vale 1 ponto para quem BATEU, multiplicado pela força.
// Quem resolve a batida é o agressor: só ele sabe a própria velocidade real no
// instante do impacto. Pela rede, a vítima vê o agressor com atraso e, quando
// percebe o contato, ele já ricocheteou e parece estar parado.

export const MIN_IMPULSE = 0.3  // m/s; empurrões menores que isso são só encostar
const HIT_COOLDOWN = 0.6        // s entre batidas do mesmo par
const TIE_MARGIN = 0.75         // m/s; diferença abaixo disso = os dois bateram

// Limites de força (m/s) medidos pela velocidade de QUEM BATEU indo na direção
// do outro. Referência: a velocidade máxima padrão do carrinho é 9 m/s.
export const scoreParams = {
  minImpact: 2.5, // abaixo disso é raspão e não pontua
  strong: 5.5,    // a partir daqui: +2 FORTE!
  smash: 7.5,     // a partir daqui: +3 PANCADA! (precisa de uns 3 s de embalo)
}

/** Pontos pela força da batida (m/s); 0 = raspão. */
export function impactPoints(impactSpeed) {
  if (impactSpeed < scoreParams.minImpact) return 0
  if (impactSpeed >= scoreParams.smash) return 3
  if (impactSpeed >= scoreParams.strong) return 2
  return 1
}

/**
 * Decide quem bateu, com as velocidades de antes da batida.
 * - 'aggressor': fui eu; resolvo a batida e ganho os pontos
 * - 'tie': os dois vieram com força parecida (ex.: de frente); cada um aplica
 *   só o próprio ricochete e ninguém pontua
 * - 'victim': foi o outro; espero a mensagem dele com o meu empurrão
 * @param {THREE.Vector3} normal do outro para mim
 * @returns {{ role: 'aggressor' | 'tie' | 'victim', impact: number }} impact =
 *   minha velocidade indo para cima do outro (a força da minha batida)
 */
export function judgeHit(normal, myVelocity, otherVelocity) {
  const myPush = -myVelocity.dot(normal)      // eu indo para cima do outro
  const theirPush = otherVelocity.dot(normal) // o outro vindo para cima de mim
  const diff = myPush - theirPush
  const role = diff > TIE_MARGIN ? 'aggressor' : diff < -TIE_MARGIN ? 'victim' : 'tie'
  return { role, impact: myPush }
}

/** Evita contar o mesmo choque várias vezes enquanto os carros se encostam. */
export class HitCooldown {
  last = new Map()
  ready(peerId, now) {
    if (this.recent(peerId, now)) return false
    this.last.set(peerId, now)
    return true
  }
  /** Já resolvi uma batida com esse jogador agora há pouco? */
  recent(peerId, now) {
    return now - (this.last.get(peerId) ?? -Infinity) < HIT_COOLDOWN
  }
}

const POPUP_DURATION = 1.1 // s
const POPUP_TEXT = { 1: '+1', 2: '+2 FORTE!', 3: '+3 PANCADA!' }

export class ScoreUI {
  constructor() {
    this.board = document.createElement('div')
    this.board.className = 'scoreboard'
    document.body.append(this.board)
    this.popups = []
    this.tmp = new THREE.Vector3()
    this.lastHtml = ''
  }

  /** @param {{ name: string, color: string, score: number, isMe: boolean }[]} players */
  render(players) {
    const rows = [...players]
      .sort((a, b) => b.score - a.score)
      .map((p) => `
        <li class="${p.isMe ? 'me' : ''}">
          <span class="dot" style="background:${p.color}"></span>
          <span class="name">${p.name}</span>
          <span class="points">${p.score}</span>
        </li>`)
      .join('')
    const html = `<h2>Placar</h2><ol>${rows}</ol>`
    // Só mexe no DOM quando algo mudou
    if (html !== this.lastHtml) {
      this.board.innerHTML = html
      this.lastHtml = html
    }
  }

  /** "+N" estilo quadrinhos subindo acima de um ponto do mundo. */
  popup(worldPosition, mult) {
    const el = document.createElement('div')
    el.className = `hit-popup mult-${mult}`
    el.textContent = POPUP_TEXT[mult]
    document.body.append(el)
    this.popups.push({ el, position: worldPosition.clone(), age: 0 })
  }

  update(dt, camera) {
    const w = window.innerWidth, h = window.innerHeight
    this.popups = this.popups.filter((p) => {
      p.age += dt
      if (p.age > POPUP_DURATION) {
        p.el.remove()
        return false
      }
      // Sobe um pouco no mundo e acompanha a câmera
      this.tmp.copy(p.position)
      this.tmp.y += 3.4 + p.age * 1.5
      this.tmp.project(camera)
      p.el.style.left = `${((this.tmp.x + 1) / 2) * w}px`
      p.el.style.top = `${((1 - this.tmp.y) / 2) * h}px`
      return true
    })
  }
}
