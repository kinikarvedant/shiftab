// Starter templates applied by the setup wizard. Prices are minor units.
// Add a business type: add an entry here; the setup wizard lists it automatically.

export interface Preset {
  label: string;
  menu: { name: string; color: string; items: [name: string, price: number, sendToKitchen?: boolean][] }[];
  floor: { name: string; tables: [name: string, seats: number][] }[];
}

const tables = (prefix: string, n: number, seats: number): [string, number][] =>
  Array.from({ length: n }, (_, i) => [`${prefix}${i + 1}`, seats]);

export const PRESETS: Record<string, Preset> = {
  restaurant: {
    label: 'Restaurant',
    menu: [
      { name: 'Starters', color: '#f59e0b', items: [['Soup of the day', 650], ['Garlic bread', 450], ['Calamari', 950], ['Bruschetta', 750]] },
      { name: 'Mains', color: '#ef4444', items: [['Ribeye steak', 2900], ['Roast chicken', 1850], ['Salmon fillet', 2200], ['Mushroom risotto', 1650], ['Burger & fries', 1600]] },
      { name: 'Sides', color: '#84cc16', items: [['Fries', 450], ['Green salad', 500], ['Mash', 450]] },
      { name: 'Desserts', color: '#ec4899', items: [['Chocolate fondant', 850], ['Cheesecake', 800], ['Ice cream', 600]] },
      { name: 'Drinks', color: '#06b6d4', items: [['Still water', 300, false], ['Cola', 350, false], ['House red (glass)', 800, false], ['House white (glass)', 800, false], ['Espresso', 300, false]] },
    ],
    floor: [
      { name: 'Main room', tables: tables('T', 10, 4) },
      { name: 'Terrace', tables: tables('P', 6, 2) },
      { name: 'Bar', tables: tables('B', 4, 2) },
    ],
  },
  cafe: {
    label: 'Café',
    menu: [
      { name: 'Coffee', color: '#a16207', items: [['Espresso', 280, false], ['Flat white', 380, false], ['Cappuccino', 380, false], ['Latte', 400, false], ['Americano', 320, false]] },
      { name: 'Tea & more', color: '#16a34a', items: [['Pot of tea', 350, false], ['Hot chocolate', 400, false], ['Fresh juice', 450, false]] },
      { name: 'Food', color: '#ea580c', items: [['Croissant', 300], ['Avocado toast', 950], ['Toastie', 750], ['Granola bowl', 800]] },
      { name: 'Cakes', color: '#db2777', items: [['Carrot cake', 450], ['Brownie', 380], ['Muffin', 350]] },
    ],
    floor: [{ name: 'Inside', tables: tables('C', 8, 2) }, { name: 'Outside', tables: tables('O', 4, 4) }],
  },
  bar: {
    label: 'Bar',
    menu: [
      { name: 'Beer', color: '#eab308', items: [['Draught lager (pint)', 650, false], ['IPA (pint)', 700, false], ['Bottled beer', 550, false]] },
      { name: 'Wine', color: '#9f1239', items: [['Red (glass)', 800, false], ['White (glass)', 800, false], ['Prosecco (glass)', 900, false], ['Bottle of house', 2800, false]] },
      { name: 'Cocktails', color: '#7c3aed', items: [['Margarita', 1100, false], ['Negroni', 1100, false], ['Old fashioned', 1200, false], ['Mojito', 1100, false]] },
      { name: 'Snacks', color: '#ea580c', items: [['Nachos', 850], ['Wings', 950], ['Fries', 450], ['Olives', 400, false]] },
    ],
    floor: [{ name: 'Bar', tables: tables('B', 8, 2) }, { name: 'Lounge', tables: tables('L', 6, 4) }],
  },
};
