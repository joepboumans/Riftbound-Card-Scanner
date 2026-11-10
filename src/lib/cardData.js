// A legend's printed name is only its title; its champion is the one tag that
// names a champion unit.
export function computeFullName(card, championNames = new Set()) {
  if (!card) return '';
  const subtitle = String(card.subtitle || '').trim();
  if (card.type === 'legend') {
    const champion = (card.tags || []).find((tag) => championNames.has(tag));
    return champion ? `${champion}, ${card.name}` : card.name;
  }
  return subtitle ? `${card.name}, ${subtitle}` : card.name;
}

// The full name to show; older or custom card data may only carry a name.
export function fullNameOf(card) {
  return card?.fullName || card?.name || '';
}

// Sort cards by full name, ignoring case and accents.
export function compareByFullName(left, right) {
  return fullNameOf(left).localeCompare(fullNameOf(right), undefined, { sensitivity: 'base' });
}

// The Code without its set total: `OGN-247/298` -> `OGN-247`.
export function codeWithoutTotal(code) {
  return String(code || '').split('/')[0].trim();
}

// The Code to show, or `#<collector number>` for card data without one.
export function codeLabelOf(card) {
  if (card?.code) return card.code;
  return card?.collectorNumber ? `#${card.collectorNumber}` : '';
}

export function withFullNames(cards = []) {
  const championNames = new Set(cards.filter((card) => card.type === 'unit').map((card) => card.name));
  return cards.map((card) => ({ ...card, fullName: computeFullName(card, championNames) }));
}

// Keep the same metadata (including cached desktop image paths) in every scan mode.
export function resolveCardData(card) {
  if (!card) return null;
  const codePart = codeWithoutTotal(card.code);
  const collectorNumber = card.collectorNumber || (codePart.includes('-')
    ? codePart.split('-').slice(1).join('-')
    : String(card.number || '').padStart(3, '0'));
  return {
    id: card.id,
    name: card.name,
    subtitle: card.subtitle,
    fullName: card.fullName || computeFullName(card),
    collectorNumber,
    code: card.code,
    set: card.set,
    setName: card.setName,
    domain: card.domain,
    domains: card.domains,
    rarity: card.rarity,
    type: card.type,
    energy: card.energy,
    might: card.might,
    tags: card.tags,
    illustrator: card.illustrator,
    text: card.text,
    imageUrl: card.imageUrl,
  };
}
