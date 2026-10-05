import { distanceToSegment } from './collision.js'

// Bots (campo de testes): um "cérebro" que olha a arena e devolve o mesmo
// que o teclado devolveria (pedal, volante e boost). O carro do bot é o mesmo
// de qualquer jogador, então ele dirige com a mesma física e as mesmas regras.
//
// Inspirado nos bots do League of Legends (Intro / Beginner / Intermediate):
// - escolhe um alvo e fica nele (não troca a cada instante), preferindo quem
//   está perto e com pouca vida (garantir o abate);
// - recua para curar quando a vida fica baixa (no LoL volta para a base; aqui
//   vai para a zona de cura, se houver uma);
// - pega itens pelo caminho (esferas de boost) quando estão à mão;
// - usa a "habilidade" (boost) quando o golpe vai acertar; o difícil ainda
//   espera o alvo estar perto da mureta para o combo TURBO + PAREDE;
// - desvia dos espinhos e das paredes de pneus;
// - a dificuldade muda o tempo de reação, a mira e o quanto ele pensa à
//   frente, não a física (o carro é igual ao seu).
// Sem dependência de navegador: os testes rodam no Node.

export const BOT_SKILLS = {
  easy: {
    label: 'Easy',
    reaction: 0.6,    // s entre uma decisão e outra (retomar alvo, decidir boost)
    aimError: 0.35,   // rad: erro de mira (sorteado a cada decisão)
    lead: 0,          // 0 = mira onde o alvo está; 1 = onde ele vai estar
    lookahead: 3,     // m à frente que ele enxerga obstáculos
    boostChance: 0.25, // chance de usar o boost quando o golpe está alinhado
    wallCombo: false, // espera o alvo perto da mureta para o boost
    retreatHp: 0,     // fração da vida em que recua para curar (0 = nunca)
    focusLowHp: 0,    // quanto prefere alvos com pouca vida
  },
  normal: {
    label: 'Normal',
    reaction: 0.3,
    aimError: 0.15,
    lead: 0.5,
    lookahead: 5,
    boostChance: 0.7,
    wallCombo: false,
    retreatHp: 0.3,
    focusLowHp: 8,
  },
  hard: {
    label: 'Hard',
    reaction: 0.12,
    aimError: 0.04,
    lead: 1,
    lookahead: 6.5,
    boostChance: 1,
    wallCombo: true,
    retreatHp: 0.35,
    focusLowHp: 15,
  },
}
export const BOT_KINDS = Object.keys(BOT_SKILLS)

const STICKINESS = 6        // m de "vantagem" do alvo atual: só troca se outro for bem melhor
const BOOST_RANGE = [3.5, 13] // m: distância boa para o boost acertar
const BOOST_ALIGN = 0.18    // rad: o alvo precisa estar bem na frente
const WALL_COMBO_RANGE = 9  // m do alvo até a mureta para valer o combo
const ORB_DETOUR = 10       // m: desvia para uma esfera se ela estiver a até isso
const RUNUP_DIST = 3.6      // m: colado no alvo e devagar = dá ré para pegar embalo
const RUNUP_SPEED = 3       // m/s
const RUNUP_TIME = 0.6      // s de ré
const STUCK_TIME = 1        // s acelerando sem sair do lugar = preso
const UNSTUCK_TIME = 0.8    // s de ré para sair
const CAR_HALF_WIDTH = 1    // m de folga do carro para os obstáculos
const WALL_MARGIN = 2       // m da mureta que já conta como "bater"
const PROBE_ANGLES = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.9, -1.9]

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
// Direção (yaw) para olhar de (x, z) até (tx, tz): frente do carro = (sin, cos)
export const headingTo = (x, z, tx, tz) => Math.atan2(tx - x, tz - z)

/**
 * @typedef {{ x: number, z: number, yaw: number, yawRate: number, speed: number,
 *   hp: number, maxHp: number, boosts: number, boosting: boolean }} BotSelf
 * @typedef {{ id: string, x: number, z: number, vx: number, vz: number,
 *   hp: number, maxHp: number, ko?: boolean, shield?: boolean }} BotEnemy
 * @typedef {{
 *   enemies: BotEnemy[],
 *   orbs: { x: number, z: number }[],                 // esferas de boost ativas
 *   heal: { x: number, z: number, radius: number }[], // zonas de cura ativas
 *   obstacles: { a: number[], b: number[], r: number }[], // cápsulas (bastão: a = b)
 *   halfX: number, halfZ: number, maxBoosts: number, maxSpeed: number,
 * }} BotWorld
 */

export class BotBrain {
  /**
   * @param {keyof typeof BOT_SKILLS} kind
   * @param {() => number} random
   */
  constructor(kind = 'normal', random = Math.random) {
    this.kind = kind
    this.skill = BOT_SKILLS[kind]
    this.random = random
    this.reset()
  }

  reset() {
    this.targetId = null
    this.mode = 'idle'   // 'chase' | 'retreat' | 'orb' | 'roam' (para depurar/testar)
    this.thinkTimer = 0  // s até a próxima decisão
    this.aimOffset = 0   // erro de mira atual (rad)
    this.wantBoost = false
    this.runUp = 0       // s de ré restantes para pegar embalo
    this.unstuck = 0     // s de ré restantes para sair de onde prendeu
    this.unstuckSteer = 1
    this.stuckTimer = 0
    this.retreating = false
  }

  /**
   * Um passo de decisão.
   * @param {number} dt
   * @param {BotSelf} self
   * @param {BotWorld} world
   * @returns {{ throttle: number, steer: number, boost: boolean }}
   */
  think(dt, self, world) {
    const s = this.skill
    // Decisões "lentas" (reação): alvo, erro de mira e se vai usar o boost
    this.thinkTimer -= dt
    const decide = this.thinkTimer <= 0
    if (decide) {
      this.thinkTimer = s.reaction * (0.75 + this.random() * 0.5)
      this.aimOffset = (this.random() * 2 - 1) * s.aimError
      this.targetId = this.pickTarget(self, world.enemies)?.id ?? null
    }
    const target = world.enemies.find((e) => e.id === this.targetId && !e.ko && !e.shield) ?? null

    // Preso (acelerando contra algo sem sair do lugar): dá ré virando
    if (this.unstuck > 0) {
      this.unstuck -= dt
      return { throttle: -1, steer: this.unstuckSteer, boost: false }
    }
    // Colado no alvo e sem velocidade: ré para ganhar embalo (batida fraca não tira vida)
    if (this.runUp > 0) {
      this.runUp -= dt
      return { throttle: -1, steer: 0, boost: false }
    }

    // Vida baixa: recua para a zona de cura mais perto (como voltar para a
    // base no LoL); volta para a briga com a vida recuperada
    const ratio = self.hp / self.maxHp
    const zone = nearest(self, world.heal)
    if (!zone || ratio > s.retreatHp + 0.35) this.retreating = false
    else if (ratio <= s.retreatHp) this.retreating = true

    let goal = null
    let stopInside = 0
    if (this.retreating) {
      this.mode = 'retreat'
      goal = zone
      stopInside = zone.radius * 0.5 // dentro da zona: para e cura
    } else {
      const orb = self.boosts < world.maxBoosts ? nearest(self, world.orbs) : null
      const orbDist = orb ? dist(self, orb) : Infinity
      const targetDist = target ? dist(self, target) : Infinity
      if (orb && orbDist < ORB_DETOUR && orbDist < targetDist * 0.6) {
        this.mode = 'orb'
        goal = orb
      } else if (target) {
        this.mode = 'chase'
        goal = this.aimPoint(self, target, world)
      } else if (orb) {
        this.mode = 'orb'
        goal = orb
      } else {
        this.mode = 'roam'
        goal = { x: 0, z: 0 } // o centro: é onde a briga e o item aparecem
      }
    }

    const d = dist(self, goal)
    const chasing = this.mode === 'chase'
    if (chasing && d < RUNUP_DIST && self.speed < RUNUP_SPEED && !self.boosting) {
      this.runUp = RUNUP_TIME
      this.stuckTimer = 0
    }

    // Direção: a desejada, desviando de obstáculos no caminho
    let heading = headingTo(self.x, self.z, goal.x, goal.z) + (chasing ? this.aimOffset : 0)
    // (os últimos metros até o alvo não contam: senão ele desviaria de quem está
    // encostado na mureta, que é justamente o melhor alvo)
    const reach = Math.min(s.lookahead + self.speed * 0.3, chasing ? d - 2 : d)
    heading = this.avoid(self, heading, reach, world)
    const error = wrapAngle(heading - self.yaw)
    const steer = clamp(error * 2.2 - self.yawRate * 0.35, -1, 1)
    // Alvo atrás: alivia o pedal para virar mais fechado
    let throttle = Math.abs(error) > 1.8 ? 0.35 : 1
    if (stopInside && d < stopInside) throttle = 0

    // Preso: acelerando, sem velocidade, por um tempo
    if (throttle > 0.5 && self.speed < 1) this.stuckTimer += dt
    else this.stuckTimer = 0
    if (this.stuckTimer > STUCK_TIME) {
      this.stuckTimer = 0
      this.unstuck = UNSTUCK_TIME
      this.unstuckSteer = this.random() < 0.5 ? -1 : 1
    }

    // Boost: decidido na reação; sai quando o golpe está alinhado e no alcance
    if (decide) this.wantBoost = chasing && this.random() < s.boostChance
    let boost = false
    if (this.wantBoost && target && self.boosts > 0 && !self.boosting) {
      const aligned = Math.abs(wrapAngle(headingTo(self.x, self.z, target.x, target.z) - self.yaw)) < BOOST_ALIGN
      const inRange = d >= BOOST_RANGE[0] && d <= BOOST_RANGE[1]
      const combo = !s.wallCombo || distanceToWall(target, self, world) < WALL_COMBO_RANGE || target.hp / target.maxHp < 0.3
      boost = aligned && inRange && combo
      if (boost) this.wantBoost = false
    }
    return { throttle, steer, boost }
  }

  /** Melhor alvo: perto e com pouca vida; o atual tem vantagem (não fica trocando). */
  pickTarget(self, enemies) {
    let best = null
    let bestScore = Infinity
    for (const e of enemies) {
      if (e.ko || e.shield) continue // nocauteado ou recém-voltado (protegido)
      let score = dist(self, e) + (e.hp / e.maxHp) * this.skill.focusLowHp
      if (e.id === this.targetId) score -= STICKINESS
      if (score < bestScore) {
        bestScore = score
        best = e
      }
    }
    return best
  }

  /** Onde mirar: onde o alvo vai estar quando o bot chegar (conforme a habilidade). */
  aimPoint(self, target, world) {
    const t = (dist(self, target) / world.maxSpeed) * this.skill.lead
    return {
      x: clamp(target.x + target.vx * t, -world.halfX, world.halfX),
      z: clamp(target.z + target.vz * t, -world.halfZ, world.halfZ),
    }
  }

  /**
   * Desvio: testa direções em leque a partir da desejada e fica com a mais
   * próxima dela que não bate em nada dentro de `reach` metros.
   */
  avoid(self, heading, reach, world) {
    if (reach <= 0.5) return heading
    for (const offset of PROBE_ANGLES) {
      const h = heading + offset
      if (pathClear(self.x, self.z, h, reach, world)) return h
    }
    return heading // tudo fechado: segue (a detecção de "preso" resolve)
  }
}

/** O caminho reto de (x, z) na direção `heading`, por `reach` m, está livre? */
export function pathClear(x, z, heading, reach, world) {
  const dx = Math.sin(heading), dz = Math.cos(heading)
  for (let t = 1; t <= reach + 1e-6; t += 1) {
    const px = x + dx * t, pz = z + dz * t
    if (Math.abs(px) > world.halfX - WALL_MARGIN || Math.abs(pz) > world.halfZ - WALL_MARGIN) {
      // Mureta: só conta se o passo está indo para fora (deixa sair de perto dela)
      if (Math.abs(px) > Math.abs(x) || Math.abs(pz) > Math.abs(z)) return false
    }
    for (const o of world.obstacles) {
      if (distanceToSegment(px, pz, o.a, o.b) < o.r + CAR_HALF_WIDTH) return false
    }
  }
  return true
}

/** Distância do alvo até a mureta, seguindo a direção bot → alvo (para onde ele seria arremessado). */
function distanceToWall(target, self, world) {
  const len = dist(self, target) || 1
  const dx = (target.x - self.x) / len, dz = (target.z - self.z) / len
  const tx = dx > 0 ? (world.halfX - target.x) / dx : dx < 0 ? (-world.halfX - target.x) / dx : Infinity
  const tz = dz > 0 ? (world.halfZ - target.z) / dz : dz < 0 ? (-world.halfZ - target.z) / dz : Infinity
  return Math.min(tx, tz)
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function nearest(from, points) {
  let best = null
  let bestD = Infinity
  for (const p of points) {
    const d = dist(from, p)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

/** Nomes dos bots (como os "Bot Annie" do LoL, mas de bate-bate). */
export const BOT_NAMES = ['Faísca', 'Buzina', 'Ferrugem', 'Pneu', 'Turbo', 'Parachoque', 'Catraca', 'Biela', 'Rebimboca', 'Calota']
