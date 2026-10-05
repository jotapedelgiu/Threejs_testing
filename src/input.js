// Estado do teclado por código físico da tecla (KeyW, ArrowUp...), então
// funciona igual em qualquer layout (ABNT, US, AZERTY...).
const pressed = new Set()
// Teclas apertadas desde a última leitura (sem contar a repetição automática)
const justPressed = new Set()

window.addEventListener('keydown', (e) => {
  // Não rouba as teclas quando o foco está num campo da GUI
  if (e.target instanceof HTMLInputElement) return
  pressed.add(e.code)
  if (!e.repeat) justPressed.add(e.code)
  if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault()
})
window.addEventListener('keyup', (e) => pressed.delete(e.code))
// Solta tudo ao trocar de aba, senão a tecla fica "presa"
window.addEventListener('blur', () => {
  pressed.clear()
  justPressed.clear()
})

export function isDown(...codes) {
  return codes.some((c) => pressed.has(c))
}

/** Eixos de direção: throttle (W/S) e steer (A/D), de -1 a 1. */
export function readDriveInput() {
  return {
    throttle: (isDown('KeyW', 'ArrowUp') ? 1 : 0) - (isDown('KeyS', 'ArrowDown') ? 1 : 0),
    steer: (isDown('KeyA', 'ArrowLeft') ? 1 : 0) - (isDown('KeyD', 'ArrowRight') ? 1 : 0),
  }
}

/** true uma única vez por toque na tecla (ex.: Espaço para usar o boost). */
export function wasPressed(code) {
  return justPressed.delete(code)
}
