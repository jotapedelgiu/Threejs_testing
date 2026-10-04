import { normalizeCode, cleanName, NAME_MAX, CODE_MAX } from './lobby.js'

// Telas antes da partida (HTML por cima do jogo):
//   início          → nome, "Criar sala" ou código + "Entrar"
//   sala de espera  → código e link para chamar os amigos, quem está na sala,
//                     "Começar partida" (só o anfitrião)
// e a contagem 3, 2, 1, JÁ! quando a partida começa. Só cuida da tela; as
// regras ficam no main.js.
//
// Nomes chegam pela rede: entram sempre por textContent, nunca innerHTML.

const NAME_KEY = 'batebate.nome' // nome lembrado neste navegador

const el = (tag, className, text) => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

function button(text, className, onClick) {
  const b = el('button', className, text)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

const storage = {
  get(key) {
    try { return localStorage.getItem(key) ?? '' } catch { return '' }
  },
  set(key, value) {
    try { localStorage.setItem(key, value) } catch { /* sem armazenamento: tudo bem */ }
  },
}

export class MenuUI {
  /**
   * @param {{
   *   inviteCode?: string,                          // veio de um link ?sala=
   *   onCreate: (name: string) => void,
   *   onJoin: (name: string, code: string) => void,
   *   onStart: () => void,
   *   onLeave: () => void,
   * }} opts
   */
  constructor({ inviteCode = '', onCreate, onJoin, onStart, onLeave }) {
    this.root = el('div', 'menu')
    this.home = this.buildHome(inviteCode, onCreate, onJoin)
    this.lobby = this.buildLobby(onStart, onLeave)
    this.lobby.hidden = true
    this.root.append(this.home, this.lobby)
    this.countdown = el('div', 'countdown')
    this.countdown.hidden = true
    document.body.append(this.root, this.countdown)
    document.body.classList.add('in-menu')
    ;(inviteCode ? this.joinButton : this.nameInput).focus()
  }

  buildHome(inviteCode, onCreate, onJoin) {
    const card = el('div', 'menu-card')
    card.append(el('h1', 'logo', 'Bate-bate'), el('p', 'tagline', 'Carrinhos de bate-bate com os amigos'))

    const nameField = el('label', 'field')
    this.nameInput = el('input')
    this.nameInput.maxLength = NAME_MAX
    this.nameInput.placeholder = 'Seu nome'
    this.nameInput.value = storage.get(NAME_KEY)
    this.nameInput.autocomplete = 'nickname'
    nameField.append(el('span', '', 'Seu nome'), this.nameInput)

    const name = () => {
      const n = cleanName(this.nameInput.value) || 'Jogador'
      storage.set(NAME_KEY, n)
      return n
    }

    this.codeInput = el('input', 'code-input')
    this.codeInput.maxLength = CODE_MAX
    this.codeInput.placeholder = 'CÓDIGO'
    this.codeInput.value = inviteCode
    this.codeInput.autocomplete = 'off'
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = normalizeCode(this.codeInput.value)
    })

    this.error = el('p', 'menu-error')
    const join = () => {
      const code = normalizeCode(this.codeInput.value)
      if (!code) {
        this.error.textContent = 'Digite o código da sala'
        this.codeInput.focus()
        return
      }
      onJoin(name(), code)
    }
    this.joinButton = button(inviteCode ? `Entrar na sala ${inviteCode}` : 'Entrar', inviteCode ? 'primary' : '', join)
    this.codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && join())
    const create = button('Criar sala', inviteCode ? '' : 'primary', () => onCreate(name()))

    const joinRow = el('div', 'join-row')
    joinRow.append(this.codeInput, this.joinButton)
    const or = el('div', 'or', 'ou entre numa sala')
    // Veio de um convite: entrar vem primeiro
    if (inviteCode) {
      // O código já está no botão: sem campo para digitar
      card.append(nameField, this.joinButton, el('div', 'or', 'ou'), create, this.error)
    }
    else card.append(nameField, create, or, joinRow, this.error)
    return card
  }

  buildLobby(onStart, onLeave) {
    const card = el('div', 'menu-card')
    this.codeText = el('div', 'room-code')
    this.linkInput = el('input', 'invite-link')
    this.linkInput.readOnly = true
    this.linkInput.addEventListener('focus', () => this.linkInput.select())
    this.copyButton = button('Copiar link de convite', '', () => this.copyLink())

    this.rosterTitle = el('h3')
    this.roster = el('ul', 'roster')
    this.startButton = button('Começar partida', 'primary', onStart)
    this.waiting = el('p', 'waiting')

    card.append(
      el('p', 'eyebrow', 'Código da sala'), this.codeText,
      this.linkInput, this.copyButton,
      this.rosterTitle, this.roster,
      this.startButton, this.waiting,
      button('Sair da sala', 'ghost', onLeave),
    )
    return card
  }

  showLobby(code, link) {
    this.codeText.textContent = code
    this.linkInput.value = link
    this.home.hidden = true
    this.lobby.hidden = false
  }

  async copyLink() {
    try {
      await navigator.clipboard.writeText(this.linkInput.value)
      this.copyButton.textContent = 'Link copiado!'
    } catch {
      // Sem permissão: deixa o link selecionado para copiar com Ctrl+C
      this.linkInput.focus()
      this.copyButton.textContent = 'Selecionado: Ctrl+C para copiar'
    }
    setTimeout(() => (this.copyButton.textContent = 'Copiar link de convite'), 2000)
  }

  /**
   * @param {{ name: string, me: boolean, host: boolean }[]} players na ordem de chegada
   * @param {{ isHost: boolean, ready: boolean }} state ready = o jogo terminou de carregar
   */
  setRoster(players, { isHost, ready }) {
    this.rosterTitle.textContent = `Jogadores (${players.length})`
    this.roster.replaceChildren(...players.map((p) => {
      const li = el('li', p.me ? 'me' : '')
      li.append(el('span', 'name', p.name))
      if (p.me) li.append(el('span', 'tag', 'você'))
      if (p.host) li.append(el('span', 'tag host', 'anfitrião'))
      return li
    }))
    this.startButton.hidden = !isHost
    this.startButton.disabled = !ready
    this.startButton.textContent = ready ? 'Começar partida' : 'Carregando…'
    this.waiting.textContent = isHost
      ? (players.length === 1 ? 'Mande o link para os amigos, ou comece sozinho' : '')
      : 'Esperando o anfitrião começar…'
  }

  /** Esconde as telas (a partida começou). */
  close() {
    this.root.hidden = true
    document.body.classList.remove('in-menu')
    document.activeElement?.blur?.() // Espaço não pode "clicar" num botão escondido
  }

  /** Contagem: número inteiro (3, 2, 1), 0 = "JÁ!", null = some. */
  showCount(n) {
    if (n === this.lastCount) return
    this.lastCount = n
    if (n === null) {
      this.countdown.hidden = true
      return
    }
    this.countdown.hidden = false
    this.countdown.textContent = n > 0 ? String(n) : 'JÁ!'
    this.countdown.classList.toggle('go', n <= 0)
    // Reinicia a animação a cada número
    this.countdown.style.animation = 'none'
    void this.countdown.offsetWidth
    this.countdown.style.animation = ''
  }
}
