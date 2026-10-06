// Game loop com passo de tempo fixo (Fiedler, "Fix Your Timestep").
//
// A tela "produz" tempo e a simulação "consome" em passos iguais de stepSeconds.
// Isso deixa a física igual em qualquer taxa de quadros e recupera o tempo
// perdido quando o navegador segura a aba: em segundo plano o
// requestAnimationFrame para e os timers da página rodam ~1x por segundo, mas
// um timer dentro de um Web Worker continua batendo, e cada tique simula todo
// o tempo que passou (até maxCatchUp, para não entrar na "espiral da morte").
//
// O desenho é separado: render recebe `alpha` (0..1), a fração do próximo
// passo já decorrida, para interpolar entre os dois últimos estados.

export class FixedStepLoop {
  /**
   * @param {{
   *   step: (dt: number, simTime: number, wallTime: number) => void,
   *   render: (dt: number, wallTime: number, alpha: number) => void,
   *   stepSeconds?: number,
   *   maxCatchUp?: number,
   *   backgroundTickMs?: number,
   *   getMaxFps?: () => number, // limite de quadros desenhados por segundo; 0 = sem limite
   * }} opts
   */
  constructor({ step, render, stepSeconds = 1 / 60, maxCatchUp = 1, backgroundTickMs = 33, getMaxFps = () => 0 }) {
    this.stepFn = step
    this.renderFn = render
    this.stepSeconds = stepSeconds
    this.maxCatchUp = maxCatchUp
    this.backgroundTickMs = backgroundTickMs
    this.simTime = 0 // relógio da simulação (s): só avança em passos fixos
    this.accumulator = 0
    this.lastWall = performance.now()
    this.lastFrame = this.lastWall
    this.getMaxFps = getMaxFps
    this.nextFrameAt = 0
  }

  start() {
    const frame = (nowMs) => {
      const maxFps = this.getMaxFps()
      if (maxFps > 0) {
        // Tolerância de 1 ms para o rAF (que cai em múltiplos do monitor) não perder quadros
        if (nowMs < this.nextFrameAt - 1) return void requestAnimationFrame(frame)
        const interval = 1000 / maxFps
        this.nextFrameAt = Math.max(this.nextFrameAt + interval, nowMs - interval)
      }
      this.advance(nowMs)
      const dt = Math.min((nowMs - this.lastFrame) / 1000, 0.1)
      this.lastFrame = nowMs
      this.renderFn(dt, nowMs / 1000, this.accumulator / this.stepSeconds)
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    this.startBackgroundTicker()
  }

  /** Consome o tempo que passou em passos fixos. */
  advance(nowMs) {
    this.accumulator += Math.min((nowMs - this.lastWall) / 1000, this.maxCatchUp)
    this.lastWall = nowMs
    while (this.accumulator >= this.stepSeconds) {
      this.accumulator -= this.stepSeconds
      this.simTime += this.stepSeconds
      // Horário (no relógio da página) a que este passo corresponde
      this.stepFn(this.stepSeconds, this.simTime, nowMs / 1000 - this.accumulator)
    }
  }

  // Timers de Web Worker não sofrem o limite de 1x/s das abas escondidas; o
  // worker só avisa a página e ela avança a simulação (sem desenhar)
  startBackgroundTicker() {
    const source = `setInterval(() => postMessage(0), ${this.backgroundTickMs})`
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    this.worker = new Worker(url)
    URL.revokeObjectURL(url) // o Worker já leu o script
    this.worker.onmessage = () => {
      const now = performance.now()
      // Com os quadros rodando, quem avança é o frame(); só entra se pararam
      if (now - this.lastWall > this.backgroundTickMs * 2) this.advance(now)
    }
  }
}
