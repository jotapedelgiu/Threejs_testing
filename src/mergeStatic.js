import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Funde as peças rígidas de um modelo que usam o MESMO material num mesmo mesh.
//
// O carro vem com 15 meshes, mas só ~5 materiais toon (paint.js): cada mesh é
// um draw call, e a cena é desenhada 3x por quadro (sombra, cor e normais do
// contorno), com até 8 carros. Fundindo por material cai de 15 para ~5 draw
// calls por carro, sem mudar um pixel: a geometria é a mesma, na mesma posição
// (a matriz de cada peça é "assada" nos vértices) e o shading só depende do
// material.
//
// Só funde o que é seguro: mesh comum (sem pele), material único e opaco (peças
// transparentes dependem da ordem de desenho), mesmas flags de sombra (castShadow
// e receiveShadow) e todas com os mesmos atributos.
// Chamar ANTES de mover/centralizar o modelo; o resultado fica no espaço local
// de `root`, então footprint, ponta da haste etc. medem o mesmo.

const KEEP = ['position', 'normal', 'uv'] // o toon só lê estes

/**
 * @param {THREE.Object3D} root
 * @returns {{ before: number, after: number }} quantos meshes havia e quantos ficaram
 */
export function mergeByMaterial(root) {
  root.updateMatrixWorld(true)
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const groups = new Map() // material + flags de sombra -> { material, meshes }
  let before = 0
  root.traverse((o) => {
    if (!o.isMesh) return
    before++
    if (o.isSkinnedMesh || o.isInstancedMesh || Array.isArray(o.material) || o.material.transparent) return
    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}`
    if (!groups.has(key)) groups.set(key, { material: o.material, meshes: [] })
    groups.get(key).meshes.push(o)
  })

  let merged = 0
  for (const { material, meshes } of groups.values()) {
    if (meshes.length < 2) continue
    const geometries = meshes.map((mesh) => bake(mesh, inverseRoot))
    const geometry = mergeGeometries(geometries, false)
    geometries.forEach((g) => g.dispose())
    if (!geometry) continue // atributos incompatíveis: deixa as peças como estão
    const mesh = new THREE.Mesh(geometry, material)
    mesh.castShadow = meshes[0].castShadow
    mesh.receiveShadow = meshes[0].receiveShadow
    root.add(mesh)
    for (const old of meshes) {
      old.removeFromParent()
      old.geometry.dispose()
    }
    merged += meshes.length - 1
  }
  return { before, after: before - merged }
}

// Cópia da geometria já no espaço local de `root`, só com os atributos que o
// toon usa e sempre indexada (mergeGeometries exige todas iguais)
function bake(mesh, inverseRoot) {
  const matrix = new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld)
  const source = mesh.geometry
  const geometry = source.clone()
  for (const name of Object.keys(geometry.attributes)) if (!KEEP.includes(name)) geometry.deleteAttribute(name)
  if (!geometry.attributes.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 2), 2))
  geometry.morphAttributes = {}
  if (!geometry.index) {
    const count = geometry.attributes.position.count
    geometry.setIndex(Array.from({ length: count }, (_, i) => i))
  }
  geometry.applyMatrix4(matrix)
  // Escala negativa (peça espelhada): o three inverte o sentido das faces no
  // desenho; como a matriz agora está nos vértices, inverte-se aqui
  if (matrix.determinant() < 0) {
    const index = geometry.index
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1)
      index.setX(i + 1, index.getX(i + 2))
      index.setX(i + 2, b)
    }
  }
  return geometry
}
