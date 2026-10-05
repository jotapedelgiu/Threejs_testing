# Bate-bate

Arena de carrinhos de bate-bate multiplayer no navegador, com visual toon
estilo quadrinhos (three.js). Jogue em
<https://jotapedelgiu.github.io/Threejs_testing/>.

## Partida

1. No menu, digite seu nome e clique em **Create room**.
2. Mande o código (ex.: `K7QX`) ou o link de convite (`?room=K7QX`) para os
   amigos. Eles entram pelo link ou digitando o código.
3. O anfitrião (quem criou a sala; se ele sair, o próximo que chegou assume)
   clica em **Start match**. Contagem 3, 2, 1, GO! e todos saem juntos.

Quem chega com a partida rolando entra direto nela.

**Vitória:** a partida dura **10 minutos**; ganha quem tiver mais abates
(K.O. em outros jogadores). O abate vai para quem causou dano por último na
vítima (até 8 s antes), inclusive arremessando contra parede ou espinhos.
Empate em abates: vitória dividida; ninguém com abate: empate. No fim, o
anfitrião pode começar outra partida (**Play again**).

**Campo de testes** (botão *Practice range* no menu): partida só sua, sem rede, com bonecos
parados que têm vida (levam dano, são nocauteados e voltam) e um painel para
pegar qualquer ultimate, zerar a recarga, chamar o item do centro e a zona
de cura, adicionar bonecos e se curar.

## Controles

| Tecla | Ação |
|---|---|
| W A S D / setas | dirigir |
| Espaço | usar boost (pegue as esferas azuis; até 2) |
| E | usar o ultimate guardado (pega no centro da arena; 1 min de recarga) |
| R | voltar ao ponto de início |

Vida: cada jogador tem 100. Toda batida tira de quem levou 4, 8 (FORTE) ou
12 (PANCADA) conforme a força de quem bateu; batida com boost tira 24
(TURBO) e, se a vítima bater na parede logo depois, mais 8 (PAREDE). Com a
vida zerada, o carrinho fica 2,5 s nocauteado e volta com vida cheia e 2 s
de proteção. Cada jogador guarda até 2 boosts. Bastões com espinhos
espalhados pela arena repelem o carro e tiram 6 (ESPINHOS).

O balanceamento (números e premissas) está em `bate-bate_balanceamento.xlsx`,
que fica fora do repositório.

## Rodar localmente

```bash
npm install
npm run dev     # servidor de desenvolvimento (http://localhost:5173)
npm test        # testes das regras do jogo (Node, sem navegador)
npm run build   # versão de produção em dist/
```

Para testar o multiplayer sozinho, abra duas **janelas** lado a lado (não
abas: o navegador pausa a aba que não está visível).

O painel de controles (escondido; abre com **F2** ou `?painel` na URL)
ajusta física, câmera, cores e efeitos. No
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
| `bats.js` | bastões com espinhos: posição, colisão e animação de ricochete |
| `ultimate.js` / `ultimateView.js` | ultimate a cada minuto no centro (anfitrião decide) e o visual dele |
| `progression.js` | níveis: o XP acumulado (dano causado, com bônus por diferença de nível e por abate) sobe o nível (120 para o 2, +138 para o 3, +156...; máx. 10); cada nível dá +5% de dano e +5 de vida máxima |
| `medkit.js` / `medkitView.js` | zona de cura: aparece perto da briga quando alguém está com a vida baixa; quem fica dentro cura até 50% da vida perdida |
| `testRange.js` | campo de testes: bonecos com vida, rede de mentira e painel |
| `match.js` | regra de vitória: relógio de 10 min, crédito dos abates e classificação |
| `spawns.js` | nascimento: um canto por jogador no início; renascer no ponto mais vazio (estilo Quake 3/Halo) |
| `tireWalls.js` | paredes de pneus: sorteio pelo mapa, girando em 90°, e colisão |
| `layout.js` | mapa de cada partida: semente nova, e a sala adota o mapa mais antigo |
| `random.js` | números aleatórios com semente (mesmas posições para a sala toda) |
| `net.js` / `protocol.js` | conexão P2P (Trystero) / formato e validação das mensagens |
| `paint.js` | pinturas (liveries), cores e brilho do boost |
| `environment.js` | fundo em degradê, sol com sombra, arena |
| `groupCamera.js` | câmera que enquadra todos os carrinhos |
| `toon.js` / `outline.js` | shader toon com retícula / contorno em pós-processamento |
| `sparks.js` | faíscas elétricas da haste, mais fortes com a velocidade |
| `hud.js` | quadro de vidas, textos de dano, barra de vida animada e boosts |
| `panel.js` | painel de controles (lil-gui), escondido atrás do F2 |
| `menu.js` | telas antes da partida (início, sala de espera) e contagem |
| `lobby.js` | código da sala, nomes e quem é o anfitrião |
| `input.js` | teclado |

Rede: cada jogador simula o próprio carro e manda o estado 20x por segundo;
os outros são mostrados 100 ms no passado, interpolando entre estados reais.
Numa batida, quem bateu resolve (calcula o próprio ricochete e manda o
empurrão e o dano da vítima); cada jogador é dono da própria vida. Referências: Glenn Fiedler, *Fix Your Timestep* e
*State Synchronization*; Gabriel Gambetta, *Entity Interpolation*.

## Publicar

Cada `git push` na `main` roda os testes, faz o build e publica no GitHub Pages.
