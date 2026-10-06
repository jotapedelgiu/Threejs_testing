import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { StateSender, FULL_EVERY } from '../src/netSend.js'
import { DR } from '../src/deadReckoning.js'
import { validators } from '../src/protocol.js'

const car = (extra = {}) => ({
  x: 12.3456789012, z: -5.6789012345, yaw: 1.5707963267, yawRate: 0, vx: 3.2109876543, vz: -1.0234567891, y: 0.0123456789,
  roll: 0.0123456789, pitch: -0.0123456789, boosting: false, tp: 0, t: 123.4567890123,
  hp: 500, ko: false, shield: false, ult: null, ghost: false, ms: 0, ...extra,
})
const slow = (extra = {}) => ({
  colors: ['#c81e34', '#1a1a1a'], livery: 'Racing Red', deaths: 1,
  koBy: { abcdefghij0123456789: 2 }, asBy: {}, xpBy: { abcdefghij0123456789: 150 }, ...extra,
})
const state = (extra = {}) => ({ ...car(), ...slow(), ...extra })
// Carro andando em linha reta, `s` segundos depois do estado base
const at = (s, extra = {}) => state({ t: 123.4567890123 + s, x: 12.3456789012 + 3.2109876543 * s, z: -5.6789012345 - 1.0234567891 * s, ...extra })

describe('Economia de rede (netSend.js)', () => {
  test('o movimento sai arredondado e continua válido', () => {
    const out = new StateSender().build(state(), 0).state
    assert.equal(out.x, 12.35)
    assert.equal(out.yaw, 1.571)
    assert.equal(out.t, 123.457)
    assert.ok(validators.state(out), 'o protocolo aceita')
  })

  test('valores padrão (false, null, 0) não vão, e quem recebe os reconstrói igual', () => {
    const out = new StateSender().build(state(), 0).state
    for (const key of ['boosting', 'ko', 'shield', 'ghost', 'ult', 'ms', 'tp']) assert.ok(!(key in out), key)
    const back = validators.state(JSON.parse(JSON.stringify(out)))
    assert.deepEqual([back.boosting, back.ko, back.shield, back.ghost, back.ult, back.ms, back.tp], [false, false, false, false, null, 0, 0])
    const on = new StateSender().build(state({ boosting: true, ko: true, ult: 'missile', ms: 3, tp: 2 }), 0).state
    assert.deepEqual([on.boosting, on.ko, on.ult, on.ms, on.tp], [true, true, 'missile', 3, 2], 'o que não é padrão vai')
  })

  test('o primeiro estado leva tudo; os seguintes só o que mudou', () => {
    const s = new StateSender()
    const first = s.build(state(), 0)
    assert.ok(first.full && first.state.colors && first.state.koBy)
    const next = s.build(at(DR.maxGap), DR.maxGap) // sinal de vida
    assert.equal(next.full, false)
    for (const key of ['colors', 'livery', 'deaths', 'koBy', 'asBy', 'xpBy']) assert.ok(!(key in next.state), `${key} fica de fora`)
    assert.equal(next.state.hp, 500, 'o que muda sempre vai')
  })

  test('campo lento que muda vai na hora, junto com os outros lentos', () => {
    const s = new StateSender()
    s.build(state(), 0)
    const out = s.build(at(0.05, { xpBy: { abcdefghij0123456789: 300 } }), 0.05)
    assert.ok(out.full)
    assert.deepEqual(out.state.xpBy, { abcdefghij0123456789: 300 })
  })

  test('a cada FULL_EVERY s repete os lentos, e forceFull (quem entrou) manda já', () => {
    const s = new StateSender()
    s.build(state(), 0)
    assert.equal(s.build(at(FULL_EVERY - 0.1), FULL_EVERY - 0.1).full, false)
    assert.equal(s.build(at(FULL_EVERY + 0.1), FULL_EVERY + 0.1).full, true)
    assert.equal(s.build(at(FULL_EVERY + 0.35), FULL_EVERY + 0.35).full, false)
    s.forceFull()
    assert.equal(s.build(at(FULL_EVERY + 0.6), FULL_EVERY + 0.6).full, true)
  })

  test('dead reckoning: carro em linha reta (o modelo acerta) não manda; só o sinal de vida', () => {
    const s = new StateSender()
    s.build(state(), 0)
    for (let i = 1; i < 5; i++) assert.equal(s.build(at(i * 0.05), i * 0.05), null, `${i * 50} ms: os outros já veem certo`)
    assert.ok(s.build(at(DR.maxGap), DR.maxGap), 'sinal de vida a cada maxGap')
    assert.equal(s.build(at(DR.maxGap + 0.05), DR.maxGap + 0.05), null, 'e volta a calar')
  })

  test('dead reckoning: carro parado também só manda o sinal de vida', () => {
    const s = new StateSender()
    const still = (t, extra) => state({ t, vx: 0, vz: 0, x: 5, z: 5, ...extra })
    s.build(still(0), 0)
    assert.equal(s.build(still(0.05), 0.05), null)
    assert.equal(s.build(still(0.2), 0.2), null)
    assert.ok(s.build(still(DR.maxGap), DR.maxGap))
  })

  test('dead reckoning: manda quando o modelo erra (virou, bateu) e quando algo não se prevê', () => {
    const base = () => {
      const s = new StateSender()
      s.build(state(), 0)
      return s
    }
    assert.ok(base().build(at(0.05, { z: -5.7 - 1.02 * 0.05 + 0.2 }), 0.05), 'posição 20 cm fora')
    assert.ok(base().build(at(0.05, { yaw: 1.5707963267 + 0.1 }), 0.05), 'direção 5,7° fora')
    // batida: a velocidade muda de repente; um tick depois a posição já fugiu do modelo
    assert.ok(base().build(at(0.1, { vx: -8, x: 12.35 + 3.21 * 0.05 - 8 * 0.05 }), 0.1), 'velocidade mudou de repente (batida)')
    for (const extra of [{ boosting: true }, { ko: true }, { shield: true }, { ult: 'missile' }, { ms: 1 }, { tp: 1 }, { hp: 480 }, { roll: 0.2 }, { y: 0.3 }]) {
      assert.ok(base().build(at(0.05, extra), 0.05), `mudou ${Object.keys(extra)[0]}: manda`)
    }
  })

  test('dead reckoning: curva constante (yawRate) também é prevista', () => {
    // arco de raio 4,5 m a 10 m/s: yawRate = v / R
    const w = 10 / 4.5
    const arc = (t) => state({
      t, yaw: w * t, yawRate: w, vx: 10 * Math.sin(w * t), vz: 10 * Math.cos(w * t),
      x: (10 / w) * (1 - Math.cos(w * t)), z: (10 / w) * Math.sin(w * t),
    })
    const s = new StateSender()
    s.build(arc(0), 0)
    for (let i = 1; i < 5; i++) assert.equal(s.build(arc(i * 0.05), i * 0.05), null, `${i * 50} ms de curva: sem mensagem`)
  })

  test('force (lista completa de bots) manda mesmo sem precisar', () => {
    const s = new StateSender()
    s.build(state(), 0)
    assert.equal(s.build(at(0.05), 0.05), null)
    assert.ok(s.build(at(0.05), 0.05, { force: true }))
  })

  test('a mensagem enxuta é bem menor que a antiga (8 jogadores)', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `jogador${i}abcdefghij${i}`)
    const tally = Object.fromEntries(ids.map((id) => [id, 123]))
    const full = state({ koBy: tally, asBy: tally, xpBy: tally })
    const s = new StateSender()
    s.build(full, 0)
    const lean = JSON.stringify(s.build({ ...at(DR.maxGap), koBy: tally, asBy: tally, xpBy: tally }, DR.maxGap).state).length
    assert.ok(lean < JSON.stringify(full).length / 3, `${lean} B contra ${JSON.stringify(full).length} B`)
  })

  test('campo ausente na validação = não mudou (undefined), e inválido continua inválido', () => {
    const base = { t: 1, x: 2, z: 3, yaw: 0, vx: 0, vz: 0, y: 0, roll: 0, pitch: 0, hp: 80, ko: false }
    const out = validators.state(base)
    for (const key of ['colors', 'livery', 'deaths', 'koBy', 'asBy', 'xpBy', 'dmgBy', 'dmgTaken']) assert.equal(out[key], undefined, key)
    assert.equal(out.yawRate, 0, 'giro ausente = 0')
    assert.equal(validators.state({ ...base, colors: 'x' }).colors, null)
    assert.deepEqual(validators.state({ ...base, koBy: { a: 2 } }).koBy, { a: 2 })
    assert.equal(validators.state({ ...base, yawRate: 1e9 }).yawRate, 50, 'giro absurdo é limitado')
  })

  test('lista de bots: entrada enxuta (sem nome/tipo) passa; tipo inválido derruba', () => {
    const base = { t: 1, x: 2, z: 3, yaw: 0, vx: 0, vz: 0, y: 0, roll: 0, pitch: 0, hp: 80, ko: false }
    const lean = validators.bots({ list: [{ id: 'bot-1', state: base }] })
    assert.equal(lean.list[0].kind, null)
    assert.equal(lean.list[0].name, null)
    const full = validators.bots({ list: [{ id: 'bot-1', name: 'Bot Pneu', kind: 'hard', state: base }] })
    assert.equal(full.list[0].kind, 'hard')
    assert.equal(validators.bots({ list: [{ id: 'bot-1', name: 'x', kind: 'god', state: base }] }), null)
  })
})
