import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { RemoteCar } from '../src/remoteCar.js'

// Extrapolação, Hermite, suavização do erro e teletransporte já são testados em
// deadReckoning.test.js; aqui ficam os casos de borda do carro remoto.
const snap = (t, extra = {}) => ({ t, x: 0, z: 0, yaw: 0, yawRate: 0, vx: 0, vz: 0, y: 0, roll: 0, pitch: 0, tp: 0, ...extra })
// Relógios iguais (clockOffset 0); o carro é desenhado INTERP_DELAY (0,1 s) no passado
const drawAt = (c, r) => c.sample(r + 0.1)
const car = () => new RemoteCar(new THREE.Object3D())

describe('Carro remoto: casos de borda (remoteCar.js)', () => {
  test('estado repetido ou atrasado é ignorado', () => {
    const c = car()
    c.setState(snap(1, { x: 5 }), 1)
    c.setState(snap(1, { x: 99 }), 1)
    c.setState(snap(0.5, { x: 77 }), 1)
    assert.equal(c.snapshots.length, 1)
    assert.equal(c.snapshots[0].x, 5)
  })

  test('erro maior que 3 m é salto de verdade: some na hora, sem deslizar', () => {
    const c = car()
    c.setState(snap(0, { x: 0 }), 0)
    drawAt(c, 0.5)
    c.setState(snap(0.6, { x: 50 }), 0.7)
    drawAt(c, 0.55)
    assert.equal(c.error.x, 0)
    assert.ok(c.root.position.x > 40)
  })

  test('teletransporte descarta o histórico', () => {
    const c = car()
    c.setState(snap(0, { x: 0 }), 0)
    c.setState(snap(0.1, { x: 1 }), 0.1)
    c.setState(snap(0.2, { x: 80, tp: 1 }), 0.2)
    assert.equal(c.snapshots.length, 1)
  })

  test('yaw interpola pelo caminho mais curto (não gira 350° em vez de 10°)', () => {
    const c = car()
    c.setState(snap(0, { yaw: Math.PI - 0.1 }), 0)
    c.setState(snap(1, { yaw: -Math.PI + 0.1 }), 1)
    drawAt(c, 0.5)
    const diff = Math.atan2(Math.sin(c.root.rotation.y - Math.PI), Math.cos(c.root.rotation.y - Math.PI))
    assert.ok(Math.abs(diff) < 1e-3, `yaw ${c.root.rotation.y}`) // sobra um resto da suavização do erro
  })
})
