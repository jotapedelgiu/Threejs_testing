import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { packMove, unpackMove, packBots, unpackBots, MOVE_BYTES } from '../src/netPack.js'
import { StateSender } from '../src/netSend.js'
import { validators } from '../src/protocol.js'
import { ULT_KINDS } from '../src/ultimate.js'

const lean = (extra = {}) => ({
  t: 123.457, x: 12.35, z: -5.68, yaw: 1.571, yawRate: 1.1, vx: 3.21, vz: -1.02, y: 0.012, roll: 0.012, pitch: -0.012,
  hp: 432, ...extra,
})
const bytesOf = (buffer) => new Uint8Array(buffer)

describe('Estado em binário (netPack.js)', () => {
  test('ida e volta: o que sai é o que entrou (nas casas arredondadas)', () => {
    const packed = packMove(lean({ boosting: true, shield: true, ult: 'missile', ms: 3, tp: 2 }))
    assert.equal(packed.byteLength, MOVE_BYTES)
    const out = unpackMove(bytesOf(packed))
    assert.deepEqual(out, {
      t: 123.457, x: 12.35, z: -5.68, yaw: 1.571, yawRate: 1.1, vx: 3.21, vz: -1.02, y: 0.012, roll: 0.012, pitch: -0.012,
      hp: 432, tp: 2, ms: 3, boosting: true, ko: false, shield: true, ghost: false, ult: 'missile',
    })
  })

  test('campos ausentes (valor padrão) voltam como false / null / 0', () => {
    const out = unpackMove(bytesOf(packMove(lean())))
    assert.deepEqual([out.boosting, out.ko, out.shield, out.ghost, out.ult, out.ms, out.tp], [false, false, false, false, null, 0, 0])
  })

  test('todos os tipos de ultimate sobrevivem', () => {
    for (const ult of ULT_KINDS) assert.equal(unpackMove(bytesOf(packMove(lean({ ult })))).ult, ult)
  })

  test('yaw gigante é normalizado (o carro girou várias voltas)', () => {
    const out = unpackMove(bytesOf(packMove(lean({ yaw: 10 * Math.PI + 0.5 }))))
    assert.ok(Math.abs(out.yaw - 0.5) < 1e-3, `yaw ${out.yaw}`)
  })

  test('valor que não cabe: não empacota (vai em JSON)', () => {
    assert.equal(packMove(lean({ x: 400 })), null, 'fora de ±327 m')
    assert.equal(packMove(lean({ vx: 500 })), null)
    assert.equal(packMove(lean({ yawRate: 40 })), null, 'giro fora do que cabe')
    assert.equal(packMove(lean({ tp: 70000 })), null, 'contador estourado')
    assert.equal(packMove(lean({ ms: -1 })), null)
    assert.equal(packMove(lean({ t: -1 })), null)
    assert.equal(packMove(lean({ x: NaN })), null)
    assert.equal(packMove(lean({ ult: 'inexistente' })), null)
  })

  test('mensagem de tamanho errado ou de outro tipo é descartada', () => {
    assert.equal(unpackMove(new Uint8Array(27)), null)
    assert.equal(unpackMove(new Uint8Array(29)), null)
    assert.equal(unpackMove('texto'), null)
    assert.equal(unpackMove({ x: 1 }), null)
    assert.equal(validators.move(new Uint8Array(3)), null)
  })

  test('chega ao jogo igual ao estado em JSON: validators.move devolve o mesmo formato', () => {
    const state = lean({ boosting: true, ms: 1 })
    const viaBinary = validators.move(bytesOf(packMove(state)))
    const viaJson = validators.state(JSON.parse(JSON.stringify(state)))
    assert.deepEqual(viaBinary, viaJson)
    assert.equal(viaBinary.koBy, undefined, 'campos lentos ausentes: não mudaram')
  })

  test('o que o StateSender manda enxuto cabe no binário, com um quarto do tamanho do JSON', () => {
    const sender = new StateSender()
    const slow = { colors: ['#c81e34', '#1a1a1a'], livery: 'Racing Red', deaths: 1, koBy: {}, asBy: {}, xpBy: {} }
    const state = (x) => ({ ...lean({ x, y: 0.0123456789, ko: false, shield: false, ult: null, ghost: false, ms: 0, tp: 0, boosting: false }), ...slow })
    sender.build(state(1), 0)
    const next = sender.build(state(1.3), 0.05)
    assert.equal(next.full, false)
    const packed = packMove(next.state)
    assert.ok(packed, 'empacotou')
    assert.ok(packed.byteLength * 3 < JSON.stringify(next.state).length, `${packed.byteLength} B contra ${JSON.stringify(next.state).length} B de JSON`)
  })

  test('lista de bots: ida e volta, e passa pela validação como a lista em JSON', () => {
    const list = [{ id: 'bot-1', state: lean({ x: 1 }) }, { id: 'bot-12', state: lean({ x: 2, ult: 'ambush', ghost: true }) }]
    const packed = packBots(list)
    assert.equal(packed.byteLength, 1 + 2 * (2 + MOVE_BYTES))
    const out = validators.botMoves(bytesOf(packed))
    assert.deepEqual(out.list.map((b) => b.id), ['bot-1', 'bot-12'])
    assert.equal(out.list[1].state.ult, 'ambush')
    assert.equal(out.list[1].state.ghost, true)
    assert.equal(out.list[0].kind, null, 'sem nome/tipo: ficam os de antes')
    assert.equal(out.list[0].state.x, 1)
  })

  test('lista de bots: a flag de lista completa vai e volta; sem ela, é parcial', () => {
    const list = [{ id: 'bot-3', state: lean() }]
    assert.equal(validators.botMoves(bytesOf(packBots(list, true))).complete, true)
    assert.equal(validators.botMoves(bytesOf(packBots(list, false))).complete, false)
    assert.equal(validators.botMoves(bytesOf(packBots(list))).list.length, 1)
    assert.equal(validators.bots({ list: [{ id: 'bot-3', name: 'x', kind: 'easy', state: lean() }], complete: true }).complete, true)
    assert.equal(validators.bots({ list: [] }).complete, false, 'JSON sem a flag: parcial')
  })

  test('lista de bots: id fora do padrão, bots demais ou tamanho errado não passam', () => {
    assert.equal(packBots([{ id: 'jogador-1', state: lean() }]), null)
    assert.equal(packBots([{ id: 'bot-99999999', state: lean() }]), null)
    assert.equal(packBots(Array.from({ length: 9 }, (_, i) => ({ id: `bot-${i}`, state: lean() }))), null)
    assert.equal(packBots([{ id: 'bot-1', state: lean({ x: 999 }) }]), null, 'estado que não cabe')
    assert.equal(unpackBots(new Uint8Array([1, 0, 0])), null, 'tamanho não bate com a contagem')
    assert.equal(unpackBots(new Uint8Array([100])), null, 'bots demais')
    assert.deepEqual(unpackBots(new Uint8Array([0])), { list: [], complete: false }, 'lista vazia')
    assert.deepEqual(unpackBots(new Uint8Array([0x80])), { list: [], complete: true }, 'lista vazia e completa')
  })
})
