const express = require('express');
const path = require('path');
const { createClaim, applyEvent, buildClaimSummary, markActionConfirmed } = require('./workflow');

const app = express();
const port = process.env.PORT || 3000;
const claims = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function getClaim(id) {
  return claims.get(id) || null;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'claim-coordinator-agent', timestamp: new Date().toISOString() });
});

app.get('/api/claims', (_req, res) => {
  res.json(Array.from(claims.values()).map(buildClaimSummary));
});

app.post('/api/claims', (req, res) => {
  const claim = createClaim(req.body || {});
  claims.set(claim.id, claim);
  res.status(201).json(buildClaimSummary(claim));
});

app.get('/api/claims/:id', (req, res) => {
  const claim = getClaim(req.params.id);
  if (!claim) {
    return res.status(404).json({ error: 'Claim not found' });
  }
  return res.json(buildClaimSummary(claim));
});

app.post('/api/claims/:id/simulate/:eventName', (req, res) => {
  const claim = getClaim(req.params.id);
  if (!claim) {
    return res.status(404).json({ error: 'Claim not found' });
  }

  const nextClaim = applyEvent(claim, req.params.eventName, req.body || {});
  return res.json(buildClaimSummary(nextClaim));
});

app.post('/api/claims/:id/actions/:actionId/confirm', (req, res) => {
  const claim = getClaim(req.params.id);
  if (!claim) {
    return res.status(404).json({ error: 'Claim not found' });
  }

  const action = markActionConfirmed(claim, req.params.actionId);
  if (!action) {
    return res.status(404).json({ error: 'Action not found' });
  }

  return res.json(buildClaimSummary(claim));
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  return res.sendFile(path.join(__dirname, '../public/index.html'));
});

const sampleClaim = createClaim();
claims.set(sampleClaim.id, sampleClaim);

app.listen(port, () => {
  console.log(`Claim Coordinator Agent running on http://localhost:${port}`);
});
