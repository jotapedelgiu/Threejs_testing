import * as THREE from 'three'
import { Health, HitCooldown, WALL_DAMAGE_WINDOW } from './damage.js'

// Campo de testes (botão no menu principal): partida só sua, sem rede, com
// bonecos para bater e um painel para testar as ultimates.
//
// O boneco é um carro de verdade sem ninguém dirigindo: tem física própria
// (é arremessado, desliza, ricocheteia nas paredes) e vida. Ele entra no jogo
// como se fosse um jogador remoto (remotePlayers.js): desenho, colisão,
// raios, etiqueta, placar e nocaute funcionam sem código especial. As
// batidas que seriam mandadas pela rede para ele chegam direto em receive().

const DUMMY_COLORS = ['#8a8f98', '#d9dce1'] // carroceria cinza: "boneco"
const tmpImpulse = new THREE.Vector3()

export class TrainingDummy {
  /**
   * @param {string} id
   * @param {string} name
   * @param {import('./car.js').Car} car física do boneco (sem modelo visível)
   * @param {{ x: number, z: number, yaw: number }} spot onde ele fica e volta
   */
  constructor(id, name, car, spot) {
    const { x, z, yaw } = spot
    this.id = id
    this.name = name
    this.spot = spot
    this.car = car
    car.spawn.set(x, 0, z)
    car.spawnYaw = yaw
    car.reset()
    this.health = new Health()
    this.boostedUntil = 0 // levou batida com boost: bater na mureta até aqui dói mais
    this.blastUntil = 0   // levou a Onda de choque: mureta e pneus doem até aqui
    this.hitCooldown = new HitCooldown() // ele batendo em mim
    this.batCooldown = new HitCooldown() // ele batendo nos bastões
  }

  get x() {
    return this.car.root.position.x
  }

  get z() {
    return this.car.root.position.z
  }

  /** Batida que um jogador "mandou" para o boneco: empurrão e dano. */
  receive(hit, now) {
    this.car.applyImpulse(tmpImpulse.set(hit.ix, 0, hit.iz))
    if (hit.boosted) this.boostedUntil = now + WALL_DAMAGE_WINDOW
    if (hit.blast) this.blastUntil = now + WALL_DAMAGE_WINDOW
    return this.health.damage(hit.damage)
  }

  /** Física sem ninguém dirigindo; volta do nocaute no lugar dele, com vida cheia. */
  update(dt) {
    if (this.health.update(dt)) this.car.reset()
    this.car.update(dt, NO_INPUT)
  }

  revive() {
    this.health = new Health()
    this.car.reset()
  }

  /** Estado no mesmo formato do que chega pela rede (protocol.js: state). */
  state(t) {
    return {
      ...this.car.getNetState(), t,
      hp: this.health.hp, ko: this.health.isKO, shield: this.health.isShielded,
      livery: null, colors: DUMMY_COLORS, ult: null,
    }
  }
}

const NO_INPUT = { throttle: 0, steer: 0 }

/**
 * "Rede" de mentira para o campo de testes: o jogo chama as mesmas funções,
 * mas nada sai do computador. Batidas em bonecos vão para `onHit`.
 * @param {(hit: object) => void} onHit
 */
export function localNet(onHit) {
  const nothing = () => {}
  return {
    selfId: 'eu',
    sendState: nothing,
    sendHit: onHit,
    sendWall: nothing,
    sendPickup: nothing,
    sendBat: nothing,
    sendLayout: nothing,
    sendHello: nothing,
    sendStart: nothing,
    sendUlt: nothing,
    sendUltReq: nothing,
    sendMedkit: nothing,
  }
}

const el = (tag, className, text) => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

/**
 * Painel do campo de testes (lateral direita).
 * @param {{
 *   ultimates: { kind: string, name: string }[],
 *   actions: Record<string, () => void>,   // botão -> ação
 *   onFreeToggle: (on: boolean) => void,   // ultimate sem recarga e sem prazo
 * }} opts
 */
export class TestPanel {
  constructor({ ultimates, actions, onFreeToggle }) {
    this.root = el('div', 'test-panel')
    this.root.append(el('h2', '', 'Practice range'))

    // Botão que solta o foco depois do clique: senão Espaço/E "clicariam" de novo
    const button = (text, onClick, className = '') => {
      const b = el('button', className, text)
      b.type = 'button'
      b.addEventListener('click', () => {
        onClick()
        b.blur()
      })
      return b
    }
    const section = (title, ...children) => {
      const s = el('div', 'test-section')
      s.append(el('h3', '', title), ...children)
      this.root.append(s)
    }

    section('Ultimates', ...ultimates.map(({ kind, name }) => button(`Get ${name}`, () => actions.giveUltimate(kind), 'ult')))
    const free = el('label', 'test-toggle')
    const box = el('input')
    box.type = 'checkbox'
    box.addEventListener('change', () => {
      onFreeToggle(box.checked)
      box.blur()
    })
    free.append(box, el('span', '', 'No cooldown / no expiry'))
    section('Cooldown',
      button('Reset cooldown', actions.resetCooldown),
      button('Spawn ult at center', actions.spawnItem),
      free,
    )
    section('Items', button('Spawn healing zone', actions.spawnMedkit, 'heal'))
    section('Dummies',
      button('Add dummy', actions.addDummy),
      button('Revive dummies', actions.reviveDummies),
    )
    section('Me',
      button('Full heal', actions.heal),
      button('Take 30 damage', actions.hurt),
      button('+2 boosts', actions.fillBoosts),
    )
    this.root.append(button('Leave practice range', actions.exit, 'exit'))
    document.body.append(this.root)
  }
}

/**
 * Lugares para os bonecos, em ordem: fileiras na frente de onde o jogador
 * nasce. O jogo usa o primeiro livre (sem boneco nem obstáculo).
 */
export const DUMMY_SPOTS = [
  [8, 0], [8, 6], [8, -6], [14, 3], [14, -3], [20, 0], [20, 6], [20, -6], [-4, 9], [-4, -9],
].map(([x, z]) => ({ x, z, yaw: -Math.PI / 2 })) // de frente para -x (onde o jogador nasce)

/** Onde o jogador nasce no campo de testes (de frente para os bonecos). */
export const TEST_SPAWN = { x: -8, z: 0 }
