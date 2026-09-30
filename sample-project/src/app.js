import { renderCard } from './components/card.ts';

function greet(name) {
    return `Hello, ${name}!`;
}

console.log(greet('World'));

const card = renderCard({
  title: 'JS Card',
  description: 'Loaded from the JS entry point with full Tailwind styling.',
});

document.getElementById('app')?.insertAdjacentHTML('beforeend', card);

const hero = `
  <div class="bg-gradient-to-r from-blue-500 to-purple-600 text-white p-12 rounded-2xl shadow-2xl mb-8">
    <h1 class="text-4xl font-extrabold tracking-tight">Welcome to the Demo</h1>
    <p class="mt-4 text-lg opacity-90">A sample project showcasing esbuild + Tailwind CSS v4 integration.</p>
  </div>
`;

document.body.insertAdjacentHTML('afterbegin', hero);