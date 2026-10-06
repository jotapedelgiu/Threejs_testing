import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { mergeByMaterial } from '../src/mergeStatic.js'

const red = new THREE.MeshBasicMaterial({ color: 'red' })
const blue = new THREE.MeshBasicMaterial({ color: 'blue' })
const box = (material, x, { cast = true, receive = false, scale = 1 } = {}) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
  mesh.position.x = x
  mesh.scale.setScalar(scale)
  mesh.castShadow = cast
  mesh.receiveShadow = receive
  return mesh
}
const meshesOf = (root) => {
  const out = []
  root.traverse((o) => o.isMesh && out.push(o))
  return out
}
const bounds = (root) => new THREE.Box3().setFromObject(root)

describe('Fusão de peças por material (mergeStatic.js)', () => {
  test('peças do mesmo material viram um mesh; a caixa envolvente não muda', () => {
    const root = new THREE.Group()
    root.add(box(red, 0), box(red, 3), box(blue, 6))
    const before = bounds(root)
    assert.deepEqual(mergeByMaterial(root), { before: 3, after: 2 })
    assert.equal(meshesOf(root).length, 2)
    assert.ok(bounds(root).equals(before))
  })

  test('a matriz de cada peça (grupo aninhado e escala) vai para os vértices', () => {
    const root = new THREE.Group()
    const nested = new THREE.Group()
    nested.position.set(0, 5, 0)
    nested.add(box(red, 0, { scale: 2 }))
    root.add(nested, box(red, 10))
    const before = bounds(root)
    mergeByMaterial(root)
    assert.ok(bounds(root).equals(before))
  })

  test('peça espelhada (escala negativa) mantém as faces para fora', () => {
    const root = new THREE.Group()
    const mirrored = box(red, 0)
    mirrored.scale.x = -1
    root.add(mirrored, box(red, 3))
    mergeByMaterial(root)
    const [merged] = meshesOf(root)
    const geometry = merged.geometry
    geometry.computeVertexNormals()
    const pos = geometry.attributes.position
    const index = geometry.index
    // sentido anti-horário visto de fora: a normal do triângulo aponta para longe do centro da peça
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    const centers = [0, 3]
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(pos, index.getX(i))
      b.fromBufferAttribute(pos, index.getX(i + 1))
      c.fromBufferAttribute(pos, index.getX(i + 2))
      const normal = b.clone().sub(a).cross(c.clone().sub(a))
      const mid = a.clone().add(b).add(c).divideScalar(3)
      const cx = centers.reduce((best, x) => (Math.abs(x - mid.x) < Math.abs(best - mid.x) ? x : best))
      const outward = mid.clone().sub(new THREE.Vector3(cx, 0, 0))
      assert.ok(normal.dot(outward) > 0, `triângulo ${i / 3} virado para dentro`)
    }
  })

  test('flags de sombra diferentes não se misturam', () => {
    const root = new THREE.Group()
    root.add(box(red, 0, { cast: true }), box(red, 3, { cast: true }), box(red, 6, { cast: false }))
    mergeByMaterial(root)
    const found = meshesOf(root)
    assert.equal(found.length, 2)
    assert.deepEqual(found.map((m) => m.castShadow).sort(), [false, true])
  })

  test('material transparente não é mexido', () => {
    const glass = new THREE.MeshBasicMaterial({ transparent: true })
    const root = new THREE.Group()
    root.add(box(glass, 0), box(glass, 3))
    assert.deepEqual(mergeByMaterial(root), { before: 2, after: 2 })
  })

  test('uma peça sozinha no material fica como está', () => {
    const root = new THREE.Group()
    const only = box(red, 0)
    root.add(only, box(blue, 3))
    mergeByMaterial(root)
    assert.ok(meshesOf(root).includes(only))
  })
})
