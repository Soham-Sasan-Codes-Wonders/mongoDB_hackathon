const crypto = require('crypto');

const TASK_DEFINITIONS = [
  { id: 'T1', title: 'Collect accident details', dependsOn: [] },
  { id: 'T2', title: 'Open the claim', dependsOn: ['T1'] },
  { id: 'T3', title: 'Adjuster assigned', dependsOn: ['T2'] },
  { id: 'T4', title: 'Check rental coverage', dependsOn: ['T2'] },
  { id: 'T5', title: 'Book the rental', dependsOn: ['T4'] },
  { id: 'T6', title: 'Book the body shop', dependsOn: ['T2'] },
  { id: 'T7', title: 'Get the repair estimate', dependsOn: ['T6'] },
  { id: 'T8', title: 'Submit the estimate', dependsOn: ['T3', 'T7'] },
  { id: 'T9', title: 'Estimate approved', dependsOn: ['T8'] },
  { id: 'T10', title: 'Authorize the repair', dependsOn: ['T9'] },
  { id: 'T11', title: 'Track the repair', dependsOn: ['T10'] },
  { id: 'T12', title: 'Extend the rental if needed', dependsOn: ['T5', 'T11'] },
  { id: 'T13', title: 'Forward medical invoices', dependsOn: ['T2'] },
  { id: 'T14', title: 'Medical reimbursement', dependsOn: ['T13'] },
  { id: 'T15', title: 'Settle the repair', dependsOn: ['T11'] },
  { id: 'T16', title: 'Car picked up', dependsOn: ['T15'] },
  { id: 'T17', title: 'Return the rental', dependsOn: ['T16'] },
  { id: 'T18', title: 'Reconcile and close', dependsOn: ['T12', 'T14', 'T17'] },
];

function makeId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

function createClaim(overrides = {}) {
  const claimNumber = `CLM-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const now = new Date().toISOString();
  const claim = {
    id: claimNumber,
    claimant: 'Ava Thompson',
    policyNumber: 'POL-1402',
    insurer: 'NorthStar Insurance',
    bodyShop: 'Lakeside Collision',
    rentalCompany: 'City Wheels',
    accidentDate: '2026-11-14',
    place: 'Austin, TX',
    otherDriver: 'M. Ramos',
    phase: 'intake',
    claimSummary: 'Rideshare collision with body damage; claim in intake.',
    money: {
      billed: 0,
      submitted: 0,
      paid: 0,
    },
    tasks: TASK_DEFINITIONS.map((task) => ({
      id: task.id,
      title: task.title,
      dependsOn: [...task.dependsOn],
      status: task.id === 'T1' ? 'ready' : 'blocked',
      proof: task.id === 'T1' ? 'Accident details captured from claimant.' : '',
      updatedAt: now,
    })),
    actions: [],
    observations: [],
    timers: [],
    experiences: [],
    approvals: [],
    eventLog: [
      { at: now, message: 'Claim created in intake.' },
    ],
    lease: {
      workerId: 'demo-worker',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  };

  Object.assign(claim, overrides);
  return claim;
}

function pushEvent(claim, message) {
  claim.eventLog.push({ at: new Date().toISOString(), message });
}

function updateTask(claim, taskId, status, proof = '') {
  const task = claim.tasks.find((item) => item.id === taskId);
  if (!task) return;
  task.status = status;
  if (proof) task.proof = proof;
  task.updatedAt = new Date().toISOString();
}

function createAction(claim, taskId, system, kind, payload, expectedEffect) {
  const action = {
    id: makeId('ACT'),
    taskId,
    system,
    kind,
    idempotencyKey: `${claim.id}:${taskId}:${kind}:${Date.now()}`,
    payload,
    expectedEffect,
    verifyBy: 'readback',
    status: 'planned',
    attempts: 0,
    deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    history: [{ status: 'planned', at: new Date().toISOString() }],
  };

  claim.actions.push(action);
  return action;
}

function markActionSent(claim, taskId, system, kind, payload, expectedEffect) {
  const action = createAction(claim, taskId, system, kind, payload, expectedEffect);
  action.status = 'sent';
  action.attempts += 1;
  action.history.push({ status: 'sent', at: new Date().toISOString() });
  pushEvent(claim, `${kind} sent to ${system}.`);
  return action;
}

function markActionConfirmed(claim, actionIdValue) {
  const action = claim.actions.find((item) => item.id === actionIdValue);
  if (!action) return null;
  action.status = 'confirmed';
  action.history.push({ status: 'confirmed', at: new Date().toISOString() });
  pushEvent(claim, `${action.kind} confirmed for ${action.taskId}.`);
  return action;
}

function markAwaitingApproval(claim, taskId, system, kind, payload, expectedEffect) {
  const action = createAction(claim, taskId, system, kind, payload, expectedEffect);
  action.status = 'awaiting_approval';
  action.history.push({ status: 'awaiting_approval', at: new Date().toISOString() });
  claim.approvals.push({
    actionId: action.id,
    taskId,
    approved: false,
    requestedAt: new Date().toISOString(),
  });
  pushEvent(claim, `${kind} is awaiting claimant approval.`);
  return action;
}

function satisfiesDependencies(claim, taskId) {
  const task = claim.tasks.find((item) => item.id === taskId);
  if (!task) return false;
  const dependencies = task.dependsOn || [];
  return dependencies.every((depId) => {
    const dep = claim.tasks.find((item) => item.id === depId);
    return dep && dep.status === 'confirmed';
  });
}

function recomputePhase(claim) {
  const taskStatuses = claim.tasks.map((task) => task.status);
  if (taskStatuses.every((status) => status === 'confirmed')) {
    claim.phase = 'closed';
    claim.claimSummary = 'Claim closed and reconciled; all tracks confirmed.';
    return;
  }

  if (taskStatuses.includes('confirmed') || claim.tasks.some((task) => task.id === 'T2' && task.status === 'confirmed')) {
    claim.phase = 'active';
    claim.claimSummary = 'Claim active; evidence is being verified and tasks are progressing.';
    return;
  }

  claim.phase = 'intake';
  claim.claimSummary = 'Claim in intake; waiting on first details.';
}

function ensureReadyTasks(claim) {
  claim.tasks.forEach((task) => {
    if (task.status === 'blocked' && satisfiesDependencies(claim, task.id)) {
      task.status = 'ready';
      task.updatedAt = new Date().toISOString();
    }
  });
}

function applyEvent(claim, eventName, payload = {}) {
  const now = new Date().toISOString();
  claim.observations.push({
    id: makeId('OBS'),
    kind: eventName,
    source: payload.source || 'demo',
    body: payload.body || {},
    observedAt: now,
  });

  switch (eventName) {
    case 'claim-filed': {
      updateTask(claim, 'T1', 'confirmed', 'Claim details accepted and validated.');
      markActionSent(claim, 'T2', 'insurer', 'open_claim', {
        policyNumber: claim.policyNumber,
        claimant: claim.claimant,
      }, { claimNumber: claim.id });
      break;
    }
    case 'claim-opened': {
      updateTask(claim, 'T2', 'confirmed', 'Insurer created the claim and returned a claim number.');
      break;
    }
    case 'rental-covered': {
      updateTask(claim, 'T4', 'confirmed', 'Rental coverage limits confirmed.');
      markActionSent(claim, 'T5', 'rental', 'create_reservation', {
        vehicleClass: 'compact',
        days: 10,
      }, { reservationExistsWithKey: true, days: 10 });
      break;
    }
    case 'rental-booked': {
      updateTask(claim, 'T5', 'confirmed', 'Rental reservation exists with the same idempotency key.');
      break;
    }
    case 'body-shop-booked': {
      updateTask(claim, 'T6', 'confirmed', 'Body shop drop-off slot confirmed.');
      break;
    }
    case 'estimate-arrived': {
      updateTask(claim, 'T7', 'confirmed', 'Repair estimate received and PDF stored.');
      markActionSent(claim, 'T8', 'insurer', 'submit_estimate', {
        estimateId: 'EST-1001',
      }, { estimateAttached: true });
      break;
    }
    case 'estimate-submitted': {
      updateTask(claim, 'T8', 'confirmed', 'Estimate attached to insurer claim.');
      updateTask(claim, 'T3', 'confirmed', 'Adjuster assigned and visible to the claim.');
      break;
    }
    case 'estimate-approved': {
      updateTask(claim, 'T9', 'confirmed', 'Estimate approved by the insurer.');
      markActionSent(claim, 'T10', 'body_shop', 'authorize_repair', {
        amount: 5400,
      }, { repairStatus: 'in_repair' });
      break;
    }
    case 'repair-authorized': {
      updateTask(claim, 'T10', 'confirmed', 'Repair authorization sent to the body shop.');
      break;
    }
    case 'repair-ready': {
      updateTask(claim, 'T11', 'confirmed', 'Body shop status shows the repair is ready.');
      break;
    }
    case 'rental-extended': {
      updateTask(claim, 'T12', 'confirmed', 'Rental was extended to match repair timing.');
      break;
    }
    case 'medical-invoice': {
      updateTask(claim, 'T13', 'confirmed', 'Clinic invoice forwarded to insurer.');
      markActionSent(claim, 'T14', 'insurer', 'reimburse_medical', {
        invoiceId: payload.invoiceId || 'INV-201',
        amount: payload.amount || 780,
      }, { paymentPosted: true });
      break;
    }
    case 'medical-paid': {
      updateTask(claim, 'T14', 'confirmed', 'Medical reimbursement received and posted.');
      break;
    }
    case 'settlement-offer': {
      updateTask(claim, 'T15', 'ready', 'Settlement offer prepared for claimant review.');
      markAwaitingApproval(claim, 'T15', 'claimant', 'accept_settlement', {
        offer: 5400,
      }, { settlementApproved: true });
      break;
    }
    case 'settlement-approved': {
      updateTask(claim, 'T15', 'confirmed', 'Claimant approved the settlement.');
      updateTask(claim, 'T16', 'confirmed', 'Vehicle release confirmed by body shop.');
      markActionSent(claim, 'T17', 'rental', 'close_reservation', {
        reservationId: 'RES-1001',
      }, { finalChargeMatchesDays: true });
      break;
    }
    case 'rental-returned': {
      updateTask(claim, 'T17', 'confirmed', 'Rental closed and final charge matched the approved days.');
      break;
    }
    case 'reconcile': {
      updateTask(claim, 'T18', 'confirmed', 'Reconciliation verified all billed, submitted and paid amounts match.');
      claim.money.billed = 6200;
      claim.money.submitted = 6200;
      claim.money.paid = 6200;
      break;
    }
    default:
      claim.eventLog.push({ at: now, message: `Unhandled event: ${eventName}` });
      break;
  }

  ensureReadyTasks(claim);
  recomputePhase(claim);
  return claim;
}

function buildClaimSummary(claim) {
  return {
    id: claim.id,
    phase: claim.phase,
    claimant: claim.claimant,
    insurer: claim.insurer,
    bodyShop: claim.bodyShop,
    rentalCompany: claim.rentalCompany,
    policyNumber: claim.policyNumber,
    money: claim.money,
    tasks: claim.tasks,
    actions: claim.actions,
    observations: claim.observations.slice(-8),
    approvals: claim.approvals,
    eventLog: claim.eventLog.slice(-20),
    claimSummary: claim.claimSummary,
  };
}

module.exports = {
  TASK_DEFINITIONS,
  createClaim,
  applyEvent,
  buildClaimSummary,
  markActionConfirmed,
  markAwaitingApproval,
  updateTask,
};
