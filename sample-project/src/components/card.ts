export interface CardProps {
  title: string;
  description: string;
  imageUrl?: string;
}

export function renderCard({ title, description, imageUrl }: CardProps): string {
  return `
    <div class="max-w-sm rounded-xl overflow-hidden shadow-lg bg-white hover:shadow-xl transition-shadow duration-300">
      ${imageUrl ? `<img class="w-full h-48 object-cover" src="${imageUrl}" alt="${title}" />` : ''}
      <div class="p-6">
        <h3 class="text-xl font-bold text-gray-900 mb-2">${title}</h3>
        <p class="text-gray-600 text-base leading-relaxed">${description}</p>
        <button class="mt-4 btn-primary">
          Learn More
        </button>
      </div>
    </div>
  `;
}