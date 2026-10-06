import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { BotBroadcaster, BOTS_COMPLETE_EVERY, applyBotList } from '../src/botBroadcast.js'
import { unpackBots } from '../src/netPack.js'
import { validators } from '../src/protocol.js'

const state = (t, extra = {}) => ({
  t, x: 1 + 3 * t, z: 2, yaw: 0, yawRate: 0, vx: 3, vz: 0, y: 0, roll: 0, pitch: 0, hp: 500,
  boosting: false, ko: false, shield: false, ult: null, ghost: false, ms: 0, tp: 0,
  colors: ['#c81e34', '#1a1a1a'], livery: 'Racing Red', deaths: 0, koBy: {}, asBy: {}, xpBy: {}, ...extra,
})
const bot = (id, t, extra) => ({ id, name: `Bot ${id}`, kind: 'easy', state: state(t, extra) })
const unpack = (out) => unpackBots(new Uint8Array(out.packed))
const ids = (out) => unpack(out).list.map((b) => b.id)

describe('Envio de bots (botBroadcast.js)', () => {
  test('o primeiro envio leva todos, com nome e tipo, em JSON', () => {
    const out = new BotBroadcaster().build([bot('bot-1', 0), bot('bot-2', 0)], 0)
    assert.ok(out.message && !out.packed)
    assert.equal(out.message.complete, true)
    assert.deepEqual(out.message.list.map((b) => [b.id, b.name, b.kind]), [['bot-1', 'Bot bot-1', 'easy'], ['bot-2', 'Bot bot-2', 'easy']])
    assert.ok(validators.bots(out.message))
  })

  test('bots em linha reta: nada a mandar até a lista completa', () => {
    const b = new BotBroadcaster()
    b.build([bot('bot-1', 0)], 0)
    assert.equal(b.build([bot('bot-1', 0.05)], 0.05), null)
    assert.equal(b.build([bot('bot-1', 0.1)], 0.1), null)
  })

  test('a lista completa volta a cada BOTS_COMPLETE_EVERY s, enxuta e em binário', () => {
    const b = new BotBroadcaster()
    b.build([bot('bot-1', 0), bot('bot-2', 0)], 0)
    const t = BOTS_COMPLETE_EVERY + 0.01
    const out = b.build([bot('bot-1', t), bot('bot-2', t)], t)
    assert.ok(out.packed, 'sem nome/tipo: binário')
    assert.deepEqual(ids(out), ['bot-1', 'bot-2'])
    assert.equal(unpack(out).complete, true)
  })

  test('só o bot que mudou vai (lista parcial)', () => {
    const b = new BotBroadcaster()
    b.build([bot('bot-1', 0), bot('bot-2', 0)], 0)
    const out = b.build([bot('bot-1', 0.05), bot('bot-2', 0.05, { hp: 300 })], 0.05)
    assert.deepEqual(ids(out), ['bot-2'])
    assert.equal(unpack(out).complete, false)
  })

  test('bot que entra ou sai manda a lista completa na hora', () => {
    const b = new BotBroadcaster()
    b.build([bot('bot-1', 0), bot('bot-2', 0)], 0)
    const gone = b.build([bot('bot-1', 0.05)], 0.05)
    assert.ok(gone.packed)
    assert.deepEqual(ids(gone), ['bot-1'])
    assert.equal(unpack(gone).complete, true, 'quem não está na lista saiu')
    const joined = b.build([bot('bot-1', 0.1), bot('bot-3', 0.1)], 0.1)
    assert.ok(joined.message, 'bot novo leva nome e tipo: JSON')
    assert.deepEqual(joined.message.list.map((x) => x.id), ['bot-1', 'bot-3'])
    assert.equal(joined.message.list[1].kind, 'easy')
  })

  test('sem bots: a lista completa vazia avisa que todos saíram', () => {
    const b = new BotBroadcaster()
    b.build([bot('bot-1', 0)], 0)
    const out = b.build([], 0.05)
    assert.deepEqual(ids(out), [])
    assert.equal(unpack(out).complete, true)
  })

  test('forceFull (alguém entrou): o próximo envio leva todos com nome e tipo', () => {
    const b = new BotBroadcaster()
    b.build([bot('bot-1', 0)], 0)
    assert.equal(b.build([bot('bot-1', 0.05)], 0.05), null)
    b.forceFull()
    const out = b.build([bot('bot-1', 0.1)], 0.1)
    assert.equal(out.message.complete, true)
    assert.equal(out.message.list[0].name, 'Bot bot-1')
  })
})

describe('Recebendo bots (applyBotList)', () => {
  const entry = (id, extra = {}) => ({ id, name: null, kind: null, state: state(0), ...extra })
  const full = (id) => entry(id, { name: `Bot ${id}`, kind: 'easy' })

  test('bot novo com nome e tipo entra e tem o estado aplicado', () => {
    const known = new Map()
    const { removed, updates } = applyBotList(known, [full('bot-1')], true)
    assert.deepEqual(removed, [])
    assert.deepEqual(updates.map((u) => u.id), ['bot-1'])
    assert.deepEqual(known.get('bot-1'), { name: 'Bot bot-1', kind: 'easy' })
  })

  test('sem nome/tipo de um bot desconhecido: espera o envio completo, não aplica', () => {
    const known = new Map()
    assert.deepEqual(applyBotList(known, [entry('bot-1')], false).updates, [])
    assert.equal(known.size, 0)
  })

  test('lista parcial não remove ninguém; a completa remove quem não veio', () => {
    const known = new Map([['bot-1', { name: 'a', kind: 'easy' }], ['bot-2', { name: 'b', kind: 'easy' }]])
    assert.deepEqual(applyBotList(known, [entry('bot-1')], false).removed, [])
    assert.equal(known.size, 2)
    const { removed, updates } = applyBotList(known, [entry('bot-1')], true)
    assert.deepEqual(removed, ['bot-2'])
    assert.deepEqual(updates.map((u) => u.id), ['bot-1'])
    assert.deepEqual([...known.keys()], ['bot-1'])
  })

  test('nome e tipo já conhecidos não são apagados por uma lista enxuta', () => {
    const known = new Map([['bot-1', { name: 'a', kind: 'hard' }]])
    applyBotList(known, [entry('bot-1')], false)
    assert.deepEqual(known.get('bot-1'), { name: 'a', kind: 'hard' })
  })
})
