const EVENT_SEQUENCE = [
  { key: 'claim-filed', label: 'Claim filed' },
  { key: 'claim-opened', label: 'Insurer opened' },
  { key: 'rental-covered', label: 'Rental covered' },
  { key: 'rental-booked', label: 'Rental booked' },
  { key: 'body-shop-booked', label: 'Body shop booked' },
  { key: 'estimate-arrived', label: 'Estimate arrived' },
  { key: 'estimate-submitted', label: 'Estimate submitted' },
  { key: 'estimate-approved', label: 'Estimate approved' },
  { key: 'repair-authorized', label: 'Repair authorized' },
  { key: 'repair-ready', label: 'Repair ready' },
  { key: 'rental-extended', label: 'Rental extended' },
  { key: 'medical-invoice', label: 'Medical invoice' },
  { key: 'medical-paid', label: 'Medical paid' },
  { key: 'settlement-offer', label: 'Settlement offer' },
  { key: 'settlement-approved', label: 'Approve settlement' },
  { key: 'rental-returned', label: 'Rental returned' },
  { key: 'reconcile', label: 'Reconcile and close' },
];

const state = {
  claim: null,
  claimId: null,
};

const phasePill = document.getElementById('phase-pill');
const eventButtons = document.getElementById('event-buttons');
const claimSummary = document.getElementById('claim-summary');
const tasksEl = document.getElementById('tasks');
const actionsEl = document.getElementById('actions');
const observationsEl = document.getElementById('observations');
const eventLogEl = document.getElementById('event-log');

function formatStatus(value) {
  return value.replace(/_/g, ' ');
}

function renderButtons() {
  eventButtons.innerHTML = '';
  EVENT_SEQUENCE.forEach(({ key, label }) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.addEventListener('click', () => simulateEvent(key));
    eventButtons.appendChild(button);
  });
}

function renderSummary(claim) {
  if (!claim) return;
  phasePill.textContent = claim.phase;
  claimSummary.innerHTML = `
    <div>
      <dt>Claim ID</dt>
      <dd>${claim.id}</dd>
    </div>
    <div>
      <dt>Phase</dt>
      <dd>${claim.phase}</dd>
    </div>
    <div>
      <dt>Claimant</dt>
      <dd>${claim.claimant}</dd>
    </div>
    <div>
      <dt>Policy</dt>
      <dd>${claim.policyNumber}</dd>
    </div>
    <div>
      <dt>Billed</dt>
      <dd>$${claim.money.billed}</dd>
    </div>
    <div>
      <dt>Submitted</dt>
      <dd>$${claim.money.submitted}</dd>
    </div>
    <div>
      <dt>Paid</dt>
      <dd>$${claim.money.paid}</dd>
    </div>
    <div>
      <dt>Summary</dt>
      <dd>${claim.claimSummary}</dd>
    </div>
  `;
}

function renderTasks(tasks) {
  tasksEl.innerHTML = '<div class="task-list">';
  tasks.forEach((task) => {
    tasksEl.innerHTML += `
      <div class="task-item">
        <div class="task-header">
          <strong>${task.id}: ${task.title}</strong>
          <span class="status ${task.status}">${formatStatus(task.status)}</span>
        </div>
        <div class="muted">${task.proof || 'Waiting for proof and validation.'}</div>
      </div>
    `;
  });
  tasksEl.innerHTML += '</div>';
}

function renderActions(actions) {
  if (!actions.length) {
    actionsEl.innerHTML = '<div class="muted">No outbound actions yet.</div>';
    return;
  }

  actionsEl.innerHTML = '<div class="actions-list">';
  actions.forEach((action) => {
    const history = action.history.slice(-3).map((entry) => `${entry.status}`).join(', ');
    actionsEl.innerHTML += `
      <div class="action-item">
        <div class="action-header">
          <strong>${action.kind}</strong>
          <span class="status ${action.status}">${formatStatus(action.status)}</span>
        </div>
        <div class="muted">Task ${action.taskId} · ${action.system} · key ${action.idempotencyKey.slice(-8)}</div>
        <div>Expected: ${JSON.stringify(action.expectedEffect)}</div>
        <div class="muted">History: ${history}</div>
      </div>
    `;
  });
  actionsEl.innerHTML += '</div>';
}

function renderObservations(observations) {
  if (!observations.length) {
    observationsEl.innerHTML = '<div class="muted">No observations.</div>';
    return;
  }

  observationsEl.innerHTML = '<div class="observations-list">';
  observations.forEach((observation) => {
    observationsEl.innerHTML += `
      <div class="observation-item">
        <strong>${observation.kind}</strong>
        <div class="muted">${observation.source}</div>
        <div>${JSON.stringify(observation.body)}</div>
      </div>
    `;
  });
  observationsEl.innerHTML += '</div>';
}

function renderLog(log) {
  eventLogEl.innerHTML = '<div class="log-list">';
  log.forEach((entry) => {
    eventLogEl.innerHTML += `
      <div class="log-item">
        <div class="muted">${new Date(entry.at).toLocaleTimeString()}</div>
        <div>${entry.message}</div>
      </div>
    `;
  });
  eventLogEl.innerHTML += '</div>';
}

function renderClaim(claim) {
  if (!claim) return;
  state.claim = claim;
  state.claimId = claim.id;
  renderSummary(claim);
  renderTasks(claim.tasks);
  renderActions(claim.actions);
  renderObservations(claim.observations);
  renderLog(claim.eventLog);
}

async function fetchClaims() {
  const response = await fetch('/api/claims');
  const claims = await response.json();
  const claim = claims[0];
  if (!claim) {
    return;
  }
  renderClaim(claim);
}

async function simulateEvent(eventName) {
  if (!state.claimId) {
    return;
  }

  const response = await fetch(`/api/claims/${state.claimId}/simulate/${eventName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'demo', body: { eventName } }),
  });

  const claim = await response.json();
  renderClaim(claim);
}

renderButtons();
fetchClaims();
