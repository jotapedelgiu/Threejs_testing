import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { StreakTracker, xpForStreak, streakName, STREAK_XP } from '../src/streaks.js'
import { TrainingDummy } from '../src/testRange.js'
import { Car } from '../src/car.js'
import * as THREE from 'three'

describe('Sequência de abates', () => {
  test('o bônus cresce a cada abate seguido e o primeiro não rende nada', () => {
    assert.equal(xpForStreak(0), 0)
    assert.equal(xpForStreak(1), 0)
    for (let n = 2; n < STREAK_XP.length - 1; n++) assert.ok(xpForStreak(n + 1) > xpForStreak(n), `abate ${n + 1} > ${n}`)
  })

  test('do 6º abate em diante vale o mesmo que o penta', () => {
    assert.equal(xpForStreak(6), xpForStreak(5))
    assert.equal(xpForStreak(20), xpForStreak(5))
  })

  test('nomes: double, triple, quadra, penta', () => {
    assert.equal(streakName(1), null)
    assert.equal(streakName(2), 'DOUBLE KILL')
    assert.equal(streakName(3), 'TRIPLE KILL')
    assert.equal(streakName(4), 'QUADRA KILL')
    assert.equal(streakName(5), 'PENTA KILL')
    assert.equal(streakName(7), '7 KILLS')
  })

  test('abater sem morrer soma; morrer zera', () => {
    const s = new StreakTracker()
    assert.equal(s.kill('ana', 'beto'), 1)
    assert.equal(s.kill('ana', 'caio'), 2)
    assert.equal(s.kill('ana', 'beto'), 3)
    assert.equal(s.kill('beto', 'ana'), 1, 'beto abate; a sequência da ana acaba')
    assert.equal(s.count('ana'), 0)
    assert.equal(s.kill('ana', 'caio'), 1, 'recomeça do zero')
  })

  test('morte sem abatedor (parede) também zera; reset limpa tudo', () => {
    const s = new StreakTracker()
    s.kill('ana', 'beto')
    s.kill('ana', 'caio')
    s.died('ana')
    assert.equal(s.count('ana'), 0)
    s.kill('ana', 'beto')
    s.reset()
    assert.equal(s.count('ana'), 0)
  })

  test('boneco: o bônus de abate é calculado depois de registrar a sequência', () => {
    const s = new StreakTracker()
    const dummy = new TrainingDummy('d1', 'D', new Car(new THREE.Object3D()), { x: 0, z: 0, yaw: 0 })
    dummy.onKnockedOut = (killer) => (killer ? s.kill(killer, 'd1') : s.died('d1'))
    s.kill('eu', 'outro') // já tenho 1 abate
    dummy.receive({ ix: 0, iz: 0, damage: 1000 }, 1, 'eu', (dealt) => dealt, () => 10 + xpForStreak(s.count('eu')))
    assert.equal(s.count('eu'), 2)
    // XP do golpe (dano causado) + abate com o bônus do double
    assert.equal(dummy.kills.xpBy.eu, dummy.health.max + 10 + xpForStreak(2))
  })
})
