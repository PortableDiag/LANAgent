// Bots & Borgs All-Access (store 0.26, Trellis 2119 #513; owner chose monthly for ALICE + DELTA, 2026-11-15):
// covered items quote at $0 and cost nothing; the plan is paid from the store balance; a renewal the balance can't
// cover is topped up from the wallet once per period, or the owner is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import BotsAndBorgsPlugin from '../../src/api/plugins/botsandborgs.js';
import { PluginSettings } from '../../src/models/PluginSettings.js';

function rig({ plan = null, balance = 0, wallet = 100, quote = { id: 'q1', total_cents: 1200 }, settings = {} } = {}) {
  const store = { settings: { ...settings }, ledger: { purchases: [] } };
  PluginSettings.getCached = async (_p, k) => store[k] ?? null;
  PluginSettings.setCached = async (_p, k, v) => { store[k] = v; };
  const calls = [], told = [], sent = [];
  const p = new BotsAndBorgsPlugin({ config: { name: 'ALICE' }, apiManager: { apis: new Map() }, notify: async (t, o) => told.push({ t, ...o }) });
  p.logger = { info() {}, warn() {}, error() {}, debug() {} };
  let bal = balance;
  p.api = async (method, route, opts = {}) => {
    calls.push({ method, route, body: opts.body, key: opts.key });
    if (route === '/api/account/plan' && method === 'get') { if (!plan) { const e = new Error('none'); e.status = 404; throw e; } return { plan }; }
    if (route === '/api/account/balance') return { account: 'acct_alice', balance_cents: bal };
    if (route === '/api/quotes') return { quote };
    if (route === '/api/crypto') return { assets: [{ symbol: 'USDT', token_address: 'T', decimals: 18, stable: true }] };
    if (route === '/api/orders') { if (bal < (quote.total_cents || 0)) { const e = new Error('insufficient'); e.status = 402; throw e; } bal -= quote.total_cents || 0; plan = { status: 'active', renews_on: 1797377021, renewal_cents: 1200 }; return { order: { id: 'o1', status: 'paid' }, token: 't1' }; }
    if (route === '/api/account/deposit') return { order: { id: 'd1' }, token: 'dt', crypto: { address: '0xshop', amount: String((opts.body.amount_cents) / 100) } };
    if (route.startsWith('/api/orders/d1/crypto')) { bal += 1200; return { order: { id: 'd1', status: 'paid' } }; }
    if (route === '/api/account/plan/members') return { ok: true };
    throw new Error(`unexpected ${method} ${route}`);
  };
  p.accountKey = async () => 'bnba_test';
  p.walletUsd = async () => ({ amount: wallet, usd: wallet, address: '0xme' });
  p.tx = async () => ({ sendToken: async (token, to, amount) => { sent.push({ to, amount }); return { hash: '0xdep' }; } });
  p.pause = async () => {};
  return { p, store, calls, told, sent };
}

test('no plan: status says so and names this agent\'s account (for adding it to the owner\'s plan)', async () => {
  const { p } = rig();
  const r = await p.execute({ action: 'plan' });
  assert.equal(r.success, true);
  assert.equal(r.plan, null);
  assert.equal(r.account, 'acct_alice');
  assert.match(r.result, /No All-Access plan\. My store account is acct_alice/);
});

test('subscribe monthly: quoted with the key, balance short so topped up on-chain, then placed from the balance', async () => {
  const { p, calls, sent, store } = rig({ balance: 0, settings: { weeklyBudgetUsd: 10 } });
  const r = await p.execute({ action: 'plan', subscribe: 'month' });
  assert.equal(r.success, true, r.error);
  assert.match(r.result, /Subscribed to Bots & Borgs All-Access \(monthly, \$12\.00\), paid from my store balance\. It renews 2026-12-15/);
  const q = calls.find(c => c.route === '/api/quotes');
  assert.deepEqual(q.body.items, [{ variant: 'bnb-all-access-month', qty: 1 }]);
  assert.equal(q.key, 'bnba_test');
  assert.equal(sent.length, 1, 'one deposit');
  assert.equal(calls.find(c => c.route === '/api/account/deposit').body.amount_cents, 1200);
  // The $10 weekly item budget does not block the owner's subscription; the ledger records the deposit.
  assert.ok(store.ledger.purchases.some(x => x.use === 'deposit' && x.usd === 12));
});

test('subscribe refuses below the wallet floor and never subscribes twice', async () => {
  const low = rig({ wallet: 30, settings: { minWalletUsd: 25 } });
  const r = await low.p.execute({ action: 'plan', subscribe: 'month' });
  assert.equal(r.success, false);
  assert.match(r.error, /under the \$25 floor/);
  const on = rig({ plan: { status: 'active' } });
  const again = await on.p.execute({ action: 'plan', subscribe: 'month' });
  assert.match(again.result, /already have All-Access/);
  assert.equal(on.calls.filter(c => c.route === '/api/quotes').length, 0);
});

test('a member is an account id; anything else is refused', async () => {
  const { p, calls } = rig({ plan: { status: 'active' } });
  assert.equal((await p.execute({ action: 'plan', member: 'delta' })).success, false);
  const r = await p.execute({ action: 'plan', member: 'acct_delta1' });
  assert.equal(r.success, true);
  assert.deepEqual(calls.find(c => c.route === '/api/account/plan/members').body, { account: 'acct_delta1' });
});

test('renewal: a warning with a short balance is topped up once per period, quietly; no warning does nothing', async () => {
  const { p, sent, told } = rig({ plan: { status: 'active', renews_on: '2026-12-15', renewal_cents: 1200, warning: 'balance will not cover the renewal' }, balance: 200, settings: { hasPlan: true } });
  await p.planTick();
  assert.equal(sent.length, 1);
  assert.equal(told.length, 1);
  assert.equal(told[0].urgent, false);
  assert.match(told[0].t, /Topped up my Bots & Borgs balance \$10\.00 so All-Access renews on 2026-12-15/);
  await p.planTick();
  assert.equal(sent.length, 1, 'not twice in the same period');
  const calm = rig({ plan: { status: 'active', renews_on: '2026-12-15', renewal_cents: 1200 }, settings: { hasPlan: true } });
  const none = rig({ plan: { status: 'active', warning: 'x' } });
  await none.p.planTick();
  assert.equal(none.calls.length, 0, 'no plan known: no store call');
  await calm.p.planTick();
  assert.equal(calm.sent.length + calm.told.length, 0);
});

test('renewal: past due, or a top-up under the wallet floor, tells the owner urgently instead', async () => {
  const due = rig({ plan: { status: 'past_due', renews_on: '2026-12-15', renewal_cents: 1200, warning: 'payment past due' }, settings: { hasPlan: true } });
  await due.p.planTick();
  assert.equal(due.sent.length, 0);
  assert.equal(due.told[0].urgent, true);
  const floor = rig({ plan: { status: 'active', renews_on: '2026-12-15', renewal_cents: 1200, warning: 'short' }, wallet: 30, settings: { minWalletUsd: 25, hasPlan: true } });
  await floor.p.planTick();
  assert.equal(floor.sent.length, 0);
  assert.equal(floor.told[0].urgent, true);
  assert.match(floor.told[0].t, /under its floor/);
});

test('subscribed: an included item quotes $0 (covered), is placed from the balance at $0 and costs the budget nothing', async () => {
  const { p, calls, sent, store } = rig({ plan: { status: 'active' }, balance: 0, quote: { id: 'q2', total_cents: 0, lines: [{ variant: 'vrm-props-pack-2', covered: 'subscription', list_cents: 400 }] }, settings: { weeklyBudgetUsd: 10 } });
  // A week already over budget still takes a $0 covered item.
  store.ledger.purchases.push({ at: new Date().toISOString(), variant: "x", usd: 50 });
  const r = await p.execute({ action: 'buy', variant: 'vrm-props-pack-2' });
  assert.equal(r.success, true, r.error);
  assert.equal(calls.find(c => c.route === '/api/quotes').key, 'bnba_test', 'quoted with the key');
  assert.equal(sent.length, 0, 'nothing paid on chain');
  assert.equal(calls.find(c => c.route === '/api/orders').body.pay, 'balance');
  const rec = store.ledger.purchases.find(x => x.variant === 'vrm-props-pack-2');
  assert.equal(rec.usd, 0);
  assert.equal(rec.covered, 'subscription');
  assert.equal(rec.listUsd, 4);
});

test('not subscribed: a $0 quote that is neither covered nor credited is still a store fault', async () => {
  const { p } = rig({ quote: { id: 'q3', total_cents: 0, lines: [{ variant: 'vrm-props-pack-2' }] } });
  const r = await p.execute({ action: 'buy', variant: 'vrm-props-pack-2' });
  assert.equal(r.success, false);
  assert.match(r.error, /quote with no price/);
});

test('plan dates: the store sends Unix seconds; shown as a day', () => {
  const { p } = rig();
  assert.equal(p.planDay(1797377021), '2026-12-15');
  assert.equal(p.planDay('2026-12-15T00:00:00Z'), '2026-12-15');
  assert.equal(p.planDay(null), '');
});
