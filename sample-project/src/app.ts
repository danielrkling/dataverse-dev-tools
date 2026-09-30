import { add, fibonacci } from './lib/math.ts';
import { formatCurrency } from './lib/format.ts';
import { renderCard } from './components/card.ts';

console.log(add(5, 6)); // 20
console.log(fibonacci(10)); // 55
console.log(formatCurrency(42.99)); // $42.99

const cardHtml = renderCard({
  title: 'Welcome',
  description: 'This card was built with TypeScript and bundled with esbuild.',
});

document.getElementById('app')?.insertAdjacentHTML('beforeend', cardHtml);

const hero = `
  <div class="bg-gradient-to-r from-blue-500 to-purple-600 text-white p-12 rounded-2xl shadow-2xl mb-8">
    <h1 class="text-4xl font-extrabold tracking-tight">Welcome to the Demo</h1>
    <p class="mt-4 text-lg opacity-90">A sample project showcasing esbuild + Tailwind CSS v4 integration.</p>
  </div>
`;

document.body.insertAdjacentHTML('afterbegin', hero);