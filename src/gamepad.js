// Controle (Gamepad API) -> o mesmo que o teclado devolve. Sem dependência de
// navegador: recebe o objeto Gamepad (ou algo no mesmo formato), então os
// testes rodam no Node.
//
// Layout "standard" (Xbox/PlayStation): LT/RT = freio/acelerador, analógico
// esquerdo = volante, A = boost, X = ultimate, Y = reiniciar o carro,
// Select = placar.

export const DEADZONE = 0.15 // analógicos nunca voltam a 0 exato: abaixo disso é ruído

// Zona morta radial com reescala: o stick sai de 0 (na borda da zona) a 1, sem
// "degrau" quando passa do limite. Radial (x e y juntos) para não deformar a
// diagonal como a zona morta por eixo deforma.
export function applyDeadzone(x, y, dead = DEADZONE) {
  const len = Math.hypot(x, y)
  if (len <= dead) return [0, 0]
  const scaled = Math.min(1, (len - dead) / (1 - dead)) / len
  return [x * scaled, y * scaled]
}

// Botão (índice do layout standard) -> código de tecla equivalente: o resto do
// jogo só pergunta por "Space", "KeyE"... e não precisa saber de onde veio
export const BUTTON_CODES = { 0: 'Space', 2: 'KeyE', 3: 'KeyR', 8: 'Tab' }

const BUTTON_ENTRIES = Object.entries(BUTTON_CODES) // fora do readPad: roda a cada poucos ms

const value = (pad, i) => pad.buttons[i]?.value ?? 0

/**
 * @param {{ axes: readonly number[], buttons: readonly { pressed: boolean, value: number }[] } | null | undefined} pad
 * @returns {{ throttle: number, steer: number, codes: string[] }}
 */
export function readPad(pad) {
  if (!pad) return { throttle: 0, steer: 0, codes: [] }
  const [sx, sy] = applyDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0)
  // Gatilhos têm valor 0..1; sem eles (controle simples), o stick para cima acelera
  const triggers = value(pad, 7) - value(pad, 6)
  const throttle = Math.abs(triggers) > 0.05 ? triggers : -sy
  const codes = []
  for (const [button, code] of BUTTON_ENTRIES) if (pad.buttons[button]?.pressed) codes.push(code)
  // Stick para a direita = volante para a direita (steer negativo, como a tecla D)
  return { throttle: Math.max(-1, Math.min(1, throttle)), steer: -sx, codes }
}
