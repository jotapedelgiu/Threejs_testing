import { distanceToSegment } from './collision.js'

// Bots: um "cérebro" que olha a arena e devolve o mesmo que o teclado
// devolveria (pedal, volante, boost e ultimate). O carro do bot é o mesmo de
// qualquer jogador, então ele dirige com a mesma física e as mesmas regras.
// Sem dependência de navegador: os testes rodam no Node.
//
// DECISÃO (IA de utilidade, como os bots de arena): a cada "reação" o bot dá
// uma nota de 0 a ~1 para cada coisa que pode fazer e vai na maior:
//   - brigar com cada inimigo: perto, com pouca vida, e eu com vida;
//   - pegar uma esfera de boost: perto e com o estoque vazio;
//   - curar na zona: quanto menos vida, mais vale;
//   - o ultimate do centro: o objetivo mais valioso do mapa; ele chega antes
//     do item aparecer, como o time que se posiciona antes do Dragão no LoL;
//   - fugir de quem está com a Sobrecarga ligada.
// A nota multiplica "considerações" (distância, vida, estoque...), cada uma
// de 0 a 1, e o peso da dificuldade. O objetivo atual ganha um bônus, para
// o bot não ficar indeciso trocando a cada instante.
//
// PROPORÇÃO briga x objetivos: a nota da briga cai com a PACIÊNCIA. Se o bot
// persegue alguém e não acerta nenhuma batida por `chaseLimit` segundos, ele
// desiste daquele alvo por um tempo e vai fazer outra coisa (outro alvo ou um
// objetivo). Os pesos foram ajustados em partidas simuladas para ficar perto
// de 60% do tempo brigando e 40% em objetivos (boost, cura, ultimate) e
// reposicionamento: o suficiente para ser agressivo sem ignorar o mapa.
// `stats` guarda quanto tempo o bot passou em cada modo (para conferir).
//
// DIREÇÃO: persegue mirando onde o alvo vai estar; ajusta a velocidade ao
// raio da curva (perseguição pura): se o arco até o alvo é mais fechado que o
// carro consegue fazer naquela velocidade, tira o pé. Sem isso, dois bots
// colados ficam girando em círculo um atrás do outro. Se mesmo assim ficar
// orbitando, sai reto para abrir distância e volta com embalo.

export const BOT_SKILLS = {
  easy: {
    label: 'Easy',
    reaction: 0.6,     // s entre uma decisão e outra
    aimError: 0.35,    // rad: erro de mira (sorteado a cada decisão)
    lead: 0,           // 0 = mira onde o alvo está; 1 = onde ele vai estar
    lookahead: 3,      // m à frente que ele enxerga obstáculos
    boostChance: 0.25, // chance de usar o boost quando o golpe está alinhado
    wallCombo: false,  // espera o alvo perto da mureta para o boost
    focusLowHp: 0,     // 0..1: quanto prefere alvos com pouca vida
    chaseLimit: 7,     // s perseguindo sem acertar até desistir do alvo
    ultAim: 0.45,      // rad: mira aceitável para soltar Onda de choque/Míssil
    weights: { fight: 1, orb: 0.6, heal: 0.35, ult: 0.6, evade: 0.4 },
  },
  normal: {
    label: 'Normal',
    reaction: 0.3,
    aimError: 0.15,
    lead: 0.5,
    lookahead: 5,
    boostChance: 0.7,
    wallCombo: false,
    focusLowHp: 0.6,
    chaseLimit: 5,
    ultAim: 0.25,
    weights: { fight: 1, orb: 1.1, heal: 1, ult: 1.2, evade: 1 },
  },
  hard: {
    label: 'Hard',
    reaction: 0.12,
    aimError: 0.04,
    lead: 1,
    lookahead: 6.5,
    boostChance: 1,
    wallCombo: true,
    focusLowHp: 1,
    chaseLimit: 4.5,
    ultAim: 0.15,
    weights: { fight: 1, orb: 1.2, heal: 1.25, ult: 1.5, evade: 1.4 },
  },
}
export const BOT_KINDS = Object.keys(BOT_SKILLS)

const KEEP_BONUS = 1.15     // o objetivo atual vale 15% a mais (não fica trocando)
const GIVE_UP_TIME = 4      // s ignorando um alvo depois de desistir dele
const BOOST_RANGE = [3.5, 13] // m: distância boa para o boost acertar
const BOOST_ALIGN = 0.18    // rad: o alvo precisa estar bem na frente
const WALL_COMBO_RANGE = 9  // m do alvo até a mureta para valer o combo
const RUNUP_DIST = 3.2      // m: colado no alvo e quase parado = dá ré para pegar embalo
const RUNUP_SPEED = 2       // m/s
const RUNUP_TIME = 0.5      // s de ré
const ORBIT_DIST = 10       // m: alvo perto...
const ORBIT_ANGLE = 1.2     // rad: ...e sempre de lado...
const ORBIT_TIME = 1.2      // s: ...por esse tempo = está orbitando
const BREAKOUT_TIME = 0.7   // s saindo reto para abrir distância
const STUCK_TIME = 1        // s acelerando sem sair do lugar = preso
const UNSTUCK_TIME = 0.8    // s de ré para sair
const MIN_CHASE_SPEED = 3   // m/s: abaixo disso não freia mais para virar
const CAR_HALF_WIDTH = 1    // m de folga do carro para os obstáculos
const WALL_MARGIN = 2       // m da mureta que já conta como "bater"
const STORM_DANGER = 11     // m de quem está com a Sobrecarga: hora de fugir
const PROBE_ANGLES = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.9, -1.9]
// Ultimate: alcance para usar cada um (m)
const ULT_RANGE = {
  overcharge: [0, 6],  // raio da tempestade é 8: usa com o alvo bem dentro
  shockwave: [3, 17],  // faixa de 22 m
  missile: [6, 40],    // cruza o mapa
  ambush: [0, 16],     // some e vai atrás de alguém; reaparece perto dele
}
const MISSILE_SPEED = 45 // m/s (ultimate.js): para mirar na frente do alvo

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
// 1 colado, 0,5 a `scale` metros, cai devagar depois
const closeness = (d, scale) => scale / (scale + d)
// Direção (yaw) para olhar de (x, z) até (tx, tz): frente do carro = (sin, cos)
export const headingTo = (x, z, tx, tz) => Math.atan2(tx - x, tz - z)

/**
 * @typedef {{ x: number, z: number, yaw: number, yawRate: number, speed: number,
 *   hp: number, maxHp: number, boosts: number, boosting: boolean,
 *   ult?: { stored: string | null, ready: boolean, active: string | null, storedLeft: number } }} BotSelf
 * @typedef {{ id: string, x: number, z: number, vx: number, vz: number,
 *   hp: number, maxHp: number, ko?: boolean, shield?: boolean, ult?: string | null }} BotEnemy
 * @typedef {{
 *   enemies: BotEnemy[],
 *   orbs: { x: number, z: number }[],                 // esferas de boost ativas
 *   heal: { x: number, z: number, radius: number }[], // zonas de cura ativas
 *   ult?: { phase: string, timer: number },           // item do centro (ultimate.js)
 *   obstacles: { a: number[], b: number[], r: number }[], // cápsulas (bastão: a = b)
 *   halfX: number, halfZ: number, maxBoosts: number, maxSpeed: number, turnSpeed?: number,
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
    this.clock = 0       // s desde que o bot começou (relógio interno)
    this.goal = null     // { key, mode, ... } objetivo atual
    this.mode = 'idle'   // 'fight' | 'orb' | 'heal' | 'ult' | 'evade' | 'roam' (+ manobras)
    this.targetId = null
    this.thinkTimer = 0
    this.aimOffset = 0
    this.wantBoost = false
    this.chaseNoHit = 0  // s perseguindo o alvo atual sem acertar
    this.gaveUp = new Map() // id -> até quando ignora esse alvo
    this.runUp = 0       // s de ré restantes para pegar embalo
    this.unstuck = 0     // s de ré restantes para sair de onde prendeu
    this.unstuckSteer = 1
    this.stuckTimer = 0
    this.orbitTimer = 0
    this.breakout = 0    // s saindo reto (quebrando a órbita)
    this.stats = {}      // modo -> s (proporção do tempo em cada coisa)
  }

  /** Acertei uma batida em `id` (main.js avisa): a paciência com ele volta. */
  noteHit(id) {
    if (id === this.targetId) this.chaseNoHit = 0
  }

  /**
   * Um passo de decisão.
   * @param {number} dt
   * @param {BotSelf} self
   * @param {BotWorld} world
   * @returns {{ throttle: number, steer: number, boost: boolean, ult: boolean }}
   */
  think(dt, self, world) {
    this.clock += dt
    const out = this.decideAndDrive(dt, self, world)
    this.stats[this.mode] = (this.stats[this.mode] ?? 0) + dt
    return out
  }

  decideAndDrive(dt, self, world) {
    const s = this.skill
    const ult = self.ult ?? { stored: null, ready: false, active: null, storedLeft: 0 }

    // Decisões "lentas" (reação): objetivo, erro de mira e se vai usar o boost
    this.thinkTimer -= dt
    const decide = this.thinkTimer <= 0
    if (decide) {
      this.thinkTimer = s.reaction * (0.75 + this.random() * 0.5)
      this.aimOffset = (this.random() * 2 - 1) * s.aimError
      this.goal = this.chooseGoal(self, world, ult)
      this.wantBoost = this.random() < s.boostChance
    }
    const goal = this.refreshGoal(self, world) // posição atual do objetivo (o alvo anda)
    const target = goal?.mode === 'fight' ? goal.enemy : null
    this.targetId = target?.id ?? null

    // Paciência: perseguindo sem acertar, a vontade de brigar com ele acaba
    if (target) {
      this.chaseNoHit += dt
      if (this.chaseNoHit > s.chaseLimit) this.giveUp(target.id)
    }

    // Manobras curtas (têm prioridade sobre o resto)
    if (this.unstuck > 0) {
      this.unstuck -= dt
      return this.maneuver('unstuck', -1, this.unstuckSteer)
    }
    if (this.runUp > 0) {
      this.runUp -= dt
      return this.maneuver('runup', -1, 0)
    }
    if (this.breakout > 0) {
      this.breakout -= dt
      return this.maneuver('breakout', 1, 0)
    }

    // Ultimate em uso: Míssil = parado mirando; Sobrecarga = colar nos outros
    if (ult.active === 'missile') {
      this.mode = 'ult-cast'
      const aim = this.nearestEnemy(self, world.enemies)
      if (!aim) return { throttle: 0, steer: 0, boost: false, ult: false }
      const t = dist(self, aim) / MISSILE_SPEED
      const h = headingTo(self.x, self.z, aim.x + aim.vx * t * s.lead, aim.z + aim.vz * t * s.lead)
      return { throttle: 0, steer: this.steerTo(h, self), boost: false, ult: false }
    }

    this.mode = goal?.mode ?? 'roam'
    const point = goal ?? { x: 0, z: 0 }
    const d = dist(self, point)
    const chasing = this.mode === 'fight'

    if (chasing && d < RUNUP_DIST && self.speed < RUNUP_SPEED && !self.boosting && ult.active !== 'overcharge') {
      this.runUp = RUNUP_TIME
      this.stuckTimer = 0
    }

    // Direção: a desejada, desviando de obstáculos no caminho (os últimos
    // metros até o alvo não contam, senão ele desviaria de quem está
    // encostado na mureta, que é justamente o melhor alvo)
    let heading = headingTo(self.x, self.z, point.x, point.z) + (chasing ? this.aimOffset : 0)
    const reach = Math.min(s.lookahead + self.speed * 0.3, chasing ? d - 2 : d)
    heading = this.avoid(self, heading, reach, world)
    const error = wrapAngle(heading - self.yaw)
    const steer = this.steerTo(heading, self)
    let throttle = this.throttleFor(error, d, self, world)
    if (goal?.stopInside && d < goal.stopInside) throttle = 0

    // Órbita: alvo perto e sempre de lado → sai reto e volta com embalo
    if ((chasing || this.mode === 'orb') && d < ORBIT_DIST && Math.abs(error) > ORBIT_ANGLE) this.orbitTimer += dt
    else this.orbitTimer = Math.max(0, this.orbitTimer - dt)
    if (this.orbitTimer > ORBIT_TIME) {
      this.orbitTimer = 0
      this.breakout = BREAKOUT_TIME
      if (chasing) this.chaseNoHit += 1.5 // órbita gasta paciência
    }

    // Preso: acelerando, sem velocidade, por um tempo
    if (throttle > 0.5 && self.speed < 1) this.stuckTimer += dt
    else this.stuckTimer = 0
    if (this.stuckTimer > STUCK_TIME) {
      this.stuckTimer = 0
      this.unstuck = UNSTUCK_TIME
      this.unstuckSteer = this.random() < 0.5 ? -1 : 1
    }

    return {
      throttle,
      steer,
      boost: !ult.stored && !ult.active && this.shouldBoost(self, target, world),
      ult: decide && ult.ready && this.shouldCastUlt(self, ult, world),
    }
  }

  maneuver(mode, throttle, steer) {
    this.mode = mode
    return { throttle, steer, boost: false, ult: false }
  }

  // --- Decisão: nota de cada objetivo -----------------------------------------
  chooseGoal(self, world, ult) {
    const w = this.skill.weights
    const myHealth = self.hp / self.maxHp
    const options = []
    const add = (score, goal) => {
      if (score <= 0) return
      if (this.goal && this.goal.key === goal.key) score *= KEEP_BONUS
      options.push({ score, goal })
    }

    // Brigar com cada inimigo
    for (const e of world.enemies) {
      if (e.ko || e.shield) continue // nocauteado ou recém-voltado (protegido)
      const d = dist(self, e)
      const lowHp = 1 - e.hp / e.maxHp
      const patience = this.patience(e.id)
      const stormy = e.ult === 'overcharge' && d < STORM_DANGER ? 0.15 : 1 // não entra na tempestade
      // Com o meu ultimate em uso (Sobrecarga), colar em alguém é o que importa
      const powered = ult.active === 'overcharge' ? 2 : 1
      const score = w.fight * closeness(d, 18) * (0.7 + 0.3 * lowHp * this.skill.focusLowHp * 2) *
        (0.35 + 0.65 * myHealth) * patience * stormy * powered
      add(score, { key: `fight:${e.id}`, mode: 'fight', enemy: e, id: e.id })
    }

    // Esferas de boost: perto e com o estoque vazio
    if (self.boosts < world.maxBoosts && !ult.stored) {
      const missing = (world.maxBoosts - self.boosts) / world.maxBoosts
      world.orbs.forEach((o) => {
        add(w.orb * missing * closeness(dist(self, o), 10), { key: `orb:${o.x.toFixed(1)},${o.z.toFixed(1)}`, mode: 'orb', x: o.x, z: o.z })
      })
    }

    // Zona de cura: vale mais quanto mais vida falta
    if (myHealth < 0.95) {
      for (const z of world.heal) {
        const score = w.heal * Math.pow(1 - myHealth, 1.3) * closeness(dist(self, z), 12) * 1.6
        add(score, { key: `heal:${z.x.toFixed(1)},${z.z.toFixed(1)}`, mode: 'heal', x: z.x, z: z.z, stopInside: z.radius * 0.5 })
      }
    }

    // Ultimate: o objetivo mais valioso. Chega antes de aparecer
    const item = world.ult && { ...world.ult, x: world.ult.x ?? 0, z: world.ult.z ?? 0 }
    if (item && !ult.stored && !ult.active) {
      const d = Math.hypot(self.x - item.x, self.z - item.z)
      const travel = d / world.maxSpeed + 1.5
      if (item.phase === 'available') {
        add(w.ult * closeness(d, 30), { key: 'ult', mode: 'ult', x: item.x, z: item.z })
      } else if (item.phase === 'warning' && item.timer < travel + 2) {
        // Espera perto do lugar (não em cima: o item aparece e ele passa)
        add(w.ult * 0.75 * closeness(d, 30), { key: 'ult', mode: 'ult', x: item.x, z: item.z, stopInside: 4 })
      }
    }

    // Fugir de quem está com a Sobrecarga ligada perto de mim
    for (const e of world.enemies) {
      if (e.ko || e.ult !== 'overcharge') continue
      const d = dist(self, e)
      if (d >= STORM_DANGER) continue
      add(w.evade * (1 - d / STORM_DANGER) * 1.2, { key: `evade:${e.id}`, mode: 'evade', enemy: e, id: e.id })
    }

    // Nada que valha: vai para o centro (é onde a briga e o item acontecem)
    add(0.05, { key: 'roam', mode: 'roam', x: 0, z: 0, stopInside: 6 })

    let best = options[0]
    for (const o of options) if (o.score > best.score) best = o
    if (best.goal.key !== this.goal?.key) this.chaseNoHit = 0
    return best.goal
  }

  /** 1 = vontade total de brigar com `id`; cai enquanto não acerta nada nele. */
  patience(id) {
    if ((this.gaveUp.get(id) ?? -Infinity) > this.clock) return 0.15
    if (id !== this.targetId) return 1
    // Cai pouco (compromisso com o alvo: não fica trocando de um para outro);
    // no limite, desiste de vez (giveUp)
    return 1 - 0.3 * Math.min(1, this.chaseNoHit / this.skill.chaseLimit)
  }

  giveUp(id) {
    this.gaveUp.set(id, this.clock + GIVE_UP_TIME)
    this.chaseNoHit = 0
    this.thinkTimer = 0 // decide outra coisa já
  }

  /** O objetivo com a posição de agora (inimigos andam, somem, ficam protegidos). */
  refreshGoal(self, world) {
    const g = this.goal
    if (!g) return null
    if (g.mode === 'fight' || g.mode === 'evade') {
      const e = world.enemies.find((x) => x.id === g.id)
      if (!e || e.ko || (g.mode === 'fight' && e.shield)) {
        this.thinkTimer = 0
        return null
      }
      if (g.mode === 'evade') {
        // Ponto para longe dele, puxado para o centro (não encurrala na mureta)
        const away = norm(self.x - e.x, self.z - e.z)
        const center = norm(-self.x, -self.z)
        return { ...g, enemy: e, x: self.x + (away.x + center.x * 0.5) * 10, z: self.z + (away.z + center.z * 0.5) * 10 }
      }
      return { ...g, enemy: e, ...this.aimPoint(self, e, world) }
    }
    return g
  }

  /** Onde mirar: onde o alvo vai estar quando o bot chegar (conforme a habilidade). */
  aimPoint(self, target, world) {
    const t = (dist(self, target) / world.maxSpeed) * this.skill.lead
    return {
      x: clamp(target.x + target.vx * t, -world.halfX, world.halfX),
      z: clamp(target.z + target.vz * t, -world.halfZ, world.halfZ),
    }
  }

  nearestEnemy(self, enemies) {
    return nearest(self, enemies.filter((e) => !e.ko))
  }

  // --- Direção ------------------------------------------------------------------
  steerTo(heading, self) {
    return clamp(wrapAngle(heading - self.yaw) * 2.2 - self.yawRate * 0.35, -1, 1)
  }

  /**
   * Pedal pela curva (perseguição pura): o arco que liga o carro ao ponto tem
   * raio d / (2·sen|erro|); a velocidade que cabe nesse arco é raio × giro.
   * Mais rápido que isso, o carro passa reto e fica orbitando o alvo.
   */
  throttleFor(error, d, self, world) {
    const turn = world.turnSpeed ?? 2.2
    const s = Math.abs(Math.sin(Math.min(Math.abs(error), Math.PI / 2)))
    const fits = s < 1e-3 ? Infinity : Math.max(MIN_CHASE_SPEED, (turn * d) / (2 * s))
    if (self.speed > fits + 2) return -0.6 // bem rápido demais: freia
    if (self.speed > fits) return 0         // um pouco: tira o pé
    return Math.abs(error) > 2.2 ? 0.5 : 1  // alvo atrás: gira com menos pedal
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

  // --- Boost e ultimate ---------------------------------------------------------
  shouldBoost(self, target, world) {
    if (!this.wantBoost || !target || self.boosts <= 0 || self.boosting) return false
    const d = dist(self, target)
    const aligned = Math.abs(wrapAngle(headingTo(self.x, self.z, target.x, target.z) - self.yaw)) < BOOST_ALIGN
    const inRange = d >= BOOST_RANGE[0] && d <= BOOST_RANGE[1]
    const combo = !this.skill.wallCombo || distanceToWall(target, self, world) < WALL_COMBO_RANGE || target.hp / target.maxHp < 0.3
    if (aligned && inRange && combo) {
      this.wantBoost = false
      return true
    }
    return false
  }

  /** Usar o ultimate guardado agora? Cada um tem o seu jeito de acertar. */
  shouldCastUlt(self, ult, world) {
    const kind = ult.stored
    const alive = world.enemies.filter((e) => !e.ko && !e.shield)
    if (!kind || !alive.length) return false
    const [min, max] = ULT_RANGE[kind]
    const inRange = alive.filter((e) => {
      const d = dist(self, e)
      return d >= min && d <= max
    })
    const expiring = ult.storedLeft < 4 // vai perder: usa no que tiver
    if (kind === 'overcharge' || kind === 'ambush') return inRange.length > 0 || (expiring && alive.some((e) => dist(self, e) < 10))
    // Onda de choque e Míssil: precisa de alguém na mira
    const aim = expiring ? this.skill.ultAim * 2 : this.skill.ultAim
    return inRange.some((e) => Math.abs(wrapAngle(headingTo(self.x, self.z, e.x, e.z) - self.yaw)) < aim)
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

function norm(x, z) {
  const len = Math.hypot(x, z) || 1
  return { x: x / len, z: z / len }
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
