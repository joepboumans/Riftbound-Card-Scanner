import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCSV, EXPORT_FORMATS } from '../src/lib/csvExporter.js';

const kaisaRebel = {
  cardData: { id: 'rad-sp4-005', name: "Kai'Sa", subtitle: 'Rebel', fullName: "Kai'Sa, Rebel", collectorNumber: 'SP4', code: 'RAD-SP4/005', set: 'RAD', setName: 'Radiance', rarity: 'epic' },
  quantity: 2, foil: true,
};

const kaisaLegend = {
  cardData: { id: 'ogn-247-298', name: 'Daughter of the Void', fullName: "Kai'Sa, Daughter of the Void", collectorNumber: '247', code: 'OGN-247/298', set: 'OGN', setName: 'Origins', rarity: 'legend' },
  quantity: 1, foil: false,
};

const signedJinx = {
  cardData: { id: 'ogn-299-298-signed', name: 'Jinx', subtitle: 'Loose Cannon', fullName: 'Jinx, Loose Cannon', collectorNumber: '299*', code: 'OGN-299*/298', set: 'OGN', setName: 'Origins', rarity: 'showcase' },
  quantity: 1, foil: true,
};

const sample = [kaisaLegend, kaisaRebel, signedJinx];

const rows =(csv) => csv.split('\r\n').map((line) => line.split(','));

test('CardNexus export ends with a Code column holding the printed code', () => {
  const [headers, row] = rows(generateCSV([kaisaRebel], EXPORT_FORMATS.CARDNEXUS));
  assert.equal(headers.at(-1), 'Code');
  assert.equal(row.at(-1), 'RAD-SP4/005');
});

test('Piltover Archive export ends with a Code column holding the printed code', () => {
  const [headers, row] = rows(generateCSV([kaisaRebel], EXPORT_FORMATS.PILTOVER));
  assert.equal(headers.at(-1), 'Code');
  assert.equal(row.at(-1), 'RAD-SP4/005');
});

test('CardNexus export names each card by its full name and keeps the other columns', () => {
  assert.equal(generateCSV(sample, EXPORT_FORMATS.CARDNEXUS), [
    'Quantity,Card Name,Collector Number,Expansion,Condition,Language,Finish,Code',
    `1,"Kai'Sa, Daughter of the Void",247,OGN,Near Mint,English,Standard,OGN-247/298`,
    `2,"Kai'Sa, Rebel",SP4,RAD,Near Mint,English,Foil,RAD-SP4/005`,
    '1,"Jinx, Loose Cannon",299,OGN,Near Mint,English,Foil,OGN-299*/298',
  ].join('\r\n'));
});

test('Piltover Archive export names each card by its full name and keeps the other columns', () => {
  assert.equal(generateCSV(sample, EXPORT_FORMATS.PILTOVER), [
    'Variant Number,Card Name,Set,Set Prefix,Rarity,Variant Type,Variant Label,Foil,Quantity,Language,Condition,Grading Company,Grading Value,Grading Label,Notes,Code',
    `OGN-247,"Kai'Sa, Daughter of the Void",Origins,OGN,Legend,Standard,Standard,false,1,English,Near Mint,,,,,OGN-247/298`,
    `RAD-SP4,"Kai'Sa, Rebel",Radiance,RAD,Epic,Standard,Standard,true,2,English,Near Mint,,,,,RAD-SP4/005`,
    'OGN-299*,"Jinx, Loose Cannon",Origins,OGN,Showcase,Overnumbered,Overnumbered,true,1,English,Near Mint,,,,,OGN-299*/298',
  ].join('\r\n'));
});

test('a saved card without a full name is exported by its printed name', () => {
  const oldEntry = { cardData: { name: 'Falling Star', collectorNumber: '030', code: 'OGN-030/298', set: 'OGN' }, quantity: 1 };
  assert.equal(generateCSV([oldEntry], EXPORT_FORMATS.CARDNEXUS).split('\r\n')[1], '1,Falling Star,030,OGN,Near Mint,English,Standard,OGN-030/298');
});
