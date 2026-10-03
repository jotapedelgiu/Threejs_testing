# Bate-bate

Arena de carrinhos de bate-bate multiplayer no navegador, com visual toon
estilo quadrinhos (three.js). Jogue em
<https://jotapedelgiu.github.io/Threejs_testing/> e chame alguém com o mesmo
link de sala: `?sala=nome`.

## Controles

| Tecla | Ação |
|---|---|
| W A S D / setas | dirigir |
| Espaço | usar boost (pegue as esferas azuis; até 3) |
| R | voltar ao ponto de início |

Vida: cada jogador tem 100. Toda batida tira de quem levou 1, 2 (FORTE) ou
3 (PANCADA) conforme a força de quem bateu; batida com boost tira 5 (TURBO)
e, se a vítima bater na parede logo depois, mais 2 (PAREDE). Com a vida
zerada, o carrinho fica 3 s nocauteado e volta com vida cheia e 2 s de
proteção.

## Rodar localmente

```bash
npm install
npm run dev     # servidor de desenvolvimento (http://localhost:5173)
npm test        # testes das regras do jogo (Node, sem navegador)
npm run build   # versão de produção em dist/
```

Para testar o multiplayer sozinho, abra duas **janelas** lado a lado (não
abas: o navegador pausa a aba que não está visível).

O painel de controles ajusta física, câmera, cores e efeitos. No
`npm run dev`, o botão "Salvar configurações" grava os valores em
`public/settings.json`, que o jogo carrega ao abrir.

## Arquitetura (`src/`)

| Módulo | Responsabilidade |
|---|---|
| `main.js` | ponto de entrada: monta as peças e contém as regras da partida |
| `loop.js` | game loop com passo fixo + relógio em Web Worker para aba escondida |
| `car.js` | física arcade do carrinho (pedal, volante, boost, batidas, quique) |
| `remoteCar.js` | carro de outro jogador, desenhado por interpolação de estados |
| `remotePlayers.js` | cria/atualiza/remove os jogadores remotos |
| `collision.js` | colisão cápsula × cápsula e cápsula × paredes |
| `damage.js` | regras de batida, dano e vida (quem bateu, força, nocaute) |
| `orbs.js` | esferas de boost com posições determinísticas por sala |
| `net.js` / `protocol.js` | conexão P2P (Trystero) / formato e validação das mensagens |
| `paint.js` | pinturas (liveries), cores e brilho do boost |
| `environment.js` | fundo em degradê, sol com sombra, arena |
| `groupCamera.js` | câmera que enquadra todos os carrinhos |
| `toon.js` / `outline.js` | shader toon com retícula / contorno em pós-processamento |
| `sparks.js` | faíscas elétricas da haste, mais fortes com a velocidade |
| `hud.js` | quadro de vidas, textos de dano e HUD do jogador (vida + boosts) |
| `panel.js` | painel de controles (lil-gui) |
| `input.js` | teclado |

Rede: cada jogador simula o próprio carro e manda o estado 20x por segundo;
os outros são mostrados 100 ms no passado, interpolando entre estados reais.
Numa batida, quem bateu resolve (calcula o próprio ricochete e manda o
empurrão e o dano da vítima); cada jogador é dono da própria vida. Referências: Glenn Fiedler, *Fix Your Timestep* e
*State Synchronization*; Gabriel Gambetta, *Entity Interpolation*.

## Publicar

Cada `git push` na `main` roda os testes, faz o build e publica no GitHub Pages.
