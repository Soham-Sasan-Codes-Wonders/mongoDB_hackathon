const test = require('node:test');
const assert = require('node:assert/strict');

const { createClaim, applyEvent } = require('../src/workflow');

test('claim advances through core workflow events', () => {
  const claim = createClaim();

  applyEvent(claim, 'claim-filed');
  applyEvent(claim, 'claim-opened');
  applyEvent(claim, 'rental-covered');
  applyEvent(claim, 'rental-booked');
  applyEvent(claim, 'body-shop-booked');
  applyEvent(claim, 'estimate-arrived');
  applyEvent(claim, 'estimate-submitted');
  applyEvent(claim, 'estimate-approved');
  applyEvent(claim, 'repair-authorized');
  applyEvent(claim, 'repair-ready');
  applyEvent(claim, 'rental-extended');
  applyEvent(claim, 'medical-invoice', { invoiceId: 'INV-909', amount: 780 });
  applyEvent(claim, 'medical-paid');
  applyEvent(claim, 'settlement-offer');
  applyEvent(claim, 'settlement-approved');
  applyEvent(claim, 'rental-returned');
  applyEvent(claim, 'reconcile');

  assert.equal(claim.phase, 'closed');
  assert.equal(claim.tasks.find((task) => task.id === 'T1').status, 'confirmed');
  assert.equal(claim.tasks.find((task) => task.id === 'T18').status, 'confirmed');
  assert.equal(claim.money.billed, 6200);
});

test('claim is seeded with a ready first task', () => {
  const claim = createClaim();
  assert.equal(claim.tasks.find((task) => task.id === 'T1').status, 'ready');
  assert.equal(claim.phase, 'intake');
});
