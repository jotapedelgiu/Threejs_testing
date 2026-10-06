import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { applyDeadzone, readPad, DEADZONE } from '../src/gamepad.js'

const buttons = (pressed = {}, values = {}) =>
  Array.from({ length: 17 }, (_, i) => ({ pressed: !!pressed[i], value: values[i] ?? (pressed[i] ? 1 : 0) }))
const pad = (axes = [0, 0, 0, 0], pressed = {}, values = {}) => ({ axes, buttons: buttons(pressed, values) })

describe('Controle (gamepad.js)', () => {
  test('dentro da zona morta o stick vale 0 (ruído do analógico)', () => {
    assert.deepEqual(applyDeadzone(0.1, 0.05), [0, 0])
    assert.deepEqual(applyDeadzone(DEADZONE, 0), [0, 0])
  })

  test('fora da zona o stick cresce de 0 a 1 sem degrau', () => {
    const [x] = applyDeadzone(DEADZONE + 0.01, 0)
    assert.ok(x > 0 && x < 0.02, `começa suave (${x})`)
    assert.deepEqual(applyDeadzone(1, 0), [1, 0])
    assert.ok(Math.hypot(...applyDeadzone(1, 1)) <= 1 + 1e-9, 'a diagonal não passa de 1')
  })

  test('stick para a direita vira volante negativo (igual à tecla D)', () => {
    assert.ok(readPad(pad([1, 0])).steer < 0)
    assert.ok(readPad(pad([-1, 0])).steer > 0)
  })

  test('gatilhos aceleram e freiam; sem gatilho, o stick para cima acelera', () => {
    assert.equal(readPad(pad([0, 0], {}, { 7: 1 })).throttle, 1)
    assert.equal(readPad(pad([0, 0], {}, { 6: 0.5 })).throttle, -0.5)
    assert.ok(readPad(pad([0, -1])).throttle > 0.9)
  })

  test('botões viram os códigos de tecla do jogo', () => {
    assert.deepEqual(readPad(pad([0, 0], { 0: true, 3: true })).codes.sort(), ['KeyR', 'Space'])
  })

  test('sem controle devolve tudo parado', () => {
    assert.deepEqual(readPad(null), { throttle: 0, steer: 0, codes: [] })
  })
})
