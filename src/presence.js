// Aparecer/sumir de um carro (ex.: nocaute e volta). Uma mola na escala:
// some encolhendo e reaparece com um "pop" (passa um pouco do tamanho normal e
// assenta). Puramente visual.

const STIFFNESS = 260
const DAMPING = 16 // menor que o crítico: reaparecer dá uma passadinha do tamanho

export class Presence {
  scale = 1
  velocity = 0

  /**
   * @param {number} dt
   * @param {boolean} shown se o carro deve estar visível
   * @returns {number} escala atual (0 = sumido)
   */
  update(dt, shown) {
    const target = shown ? 1 : 0
    // Passo limitado: depois de uma pausa longa a mola não explode
    const step = Math.min(dt, 1 / 30)
    this.velocity += (STIFFNESS * (target - this.scale) - DAMPING * this.velocity) * step
    this.scale += this.velocity * step
    if (!shown && this.scale < 0.02) {
      this.scale = 0
      this.velocity = 0
    }
    return Math.max(this.scale, 0)
  }

  /** Aplica no objeto: escala e visibilidade (sumido não é desenhado). */
  apply(object, scale) {
    object.scale.setScalar(Math.max(scale, 0.0001))
    object.visible = scale > 0.01
  }
}
