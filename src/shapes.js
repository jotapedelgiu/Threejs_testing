import * as THREE from 'three'

// Formas alternativas para o carrinho (só visual, a colisão usa o tamanho
// medido do modelo). Uso: ?forma na URL. Tamanho parecido com o BumpyCar.glb
// (≈1,28 x 2,66 m), frente = +Z.
// Camadas de material: 0 carroceria principal, 1 secundária, 2 metal, 3 borracha.

/** Piadinha de amigos: o carrinho vira um "mascote" bem-humorado. */
export function buildFunnyCar(mats) {
  const [primary, secondary, metal, rubber] = mats
  const root = new THREE.Group()
  const mesh = (geo, material) => {
    const m = new THREE.Mesh(geo, material)
    m.castShadow = true
    m.receiveShadow = true
    root.add(m)
    return m
  }

  // Corpo (haste): cilindro deitado com a ponta em +Z
  const shaft = mesh(new THREE.CylinderGeometry(0.4, 0.42, 1.5, 32), primary)
  shaft.rotation.x = Math.PI / 2
  shaft.position.set(0, 0.85, 0.1)

  // Cabeça: esfera um pouco mais larga na frente
  const head = mesh(new THREE.SphereGeometry(0.5, 32, 24), secondary)
  head.scale.set(1, 1, 1.15)
  head.position.set(0, 0.85, 0.78)

  // Dois "pares" atrás
  for (const side of [-1, 1]) {
    const ball = mesh(new THREE.SphereGeometry(0.36, 28, 20), primary)
    ball.position.set(side * 0.3, 0.62, -0.95)
  }

  // Rodas
  for (const [x, z] of [[-0.55, 0.8], [0.55, 0.8], [-0.55, -0.7], [0.55, -0.7]]) {
    const wheel = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 20), rubber)
    wheel.rotation.z = Math.PI / 2
    wheel.position.set(x, 0.3, z)
  }

  // Haste de energia (de onde saem as faíscas), com marcador da ponta
  const pole = mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 8), metal)
  pole.position.set(0, 1.85, -0.35)
  const tip = new THREE.Object3D()
  tip.name = 'poleTip'
  tip.position.set(0, 2.6, -0.35)
  root.add(tip)

  return root
}

export const SHAPES = { funny: buildFunnyCar }
