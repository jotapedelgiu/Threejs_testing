// Pinturas ("liveries") dos carrinhos: duas cores análogas (vizinhas no
// círculo cromático) para a carroceria principal e a secundária. A secundária
// é um pouco mais clara para as duas partes se separarem bem no toon.
export const LIVERIES = [
  { name: 'Fogo', primary: '#e63946', secondary: '#f4a261' },
  { name: 'Oceano', primary: '#1d6fd8', secondary: '#2ec4b6' },
  { name: 'Limão', primary: '#5fae1e', secondary: '#f2d43d' },
  { name: 'Uva', primary: '#7b2cbf', secondary: '#e056a0' },
  { name: 'Pôr do sol', primary: '#ff6b00', secondary: '#ffc300' },
  { name: 'Menta', primary: '#1f9e63', secondary: '#38d1d6' },
  { name: 'Coral', primary: '#e5386d', secondary: '#ff8a5c' },
  { name: 'Noite', primary: '#3a3dce', secondary: '#a066e8' },
  { name: 'Turquesa', primary: '#14b89a', secondary: '#4fb3f0' },
]

/** Sorteia uma pintura, evitando os nomes em `taken` sempre que possível. */
export function pickLivery(taken = []) {
  const free = LIVERIES.filter((l) => !taken.includes(l.name))
  const pool = free.length ? free : LIVERIES
  return pool[Math.floor(Math.random() * pool.length)]
}
