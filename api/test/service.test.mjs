import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db.mjs';
import { serviceInfo, serviceBalance, chooseServicePlan, applyServicePayment, renewService, startServiceTopup } from '../src/service.mjs';
import { paymentToken, validPaymentToken } from '../src/tbankpay.mjs';
import { deleteAccount } from '../src/budgets.mjs';
import { planOf, setPlan } from '../src/plans.mjs';
import { requestTicket, fetchTicket } from '../src/fns.mjs';

process.env.TBANK_ACQUIRING_TERMINAL = 'test-terminal';
process.env.TBANK_ACQUIRING_PASSWORD = 'test-secret';
process.env.SERVICE_PUBLIC_ORIGIN = 'https://example.test';
process.env.SERVICE_BILLING_ENABLED = '1';
process.env.SERVICE_BILLING_MODE = 'live';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  t.after(() => db.close());
  const create = (login, budget = null) => {
    const id = Number(db.prepare("INSERT INTO users(login,password,created_at) VALUES (?,'!',?)").run(login,new Date().toISOString()).lastInsertRowid);
    if (!budget) budget = Number(db.prepare("INSERT INTO budgets(name,owner_id,created_at) VALUES ('Test',?,?)").run(id,new Date().toISOString()).lastInsertRowid);
    db.prepare('UPDATE users SET budget_id=?,home_budget_id=? WHERE id=?').run(budget,budget,id);
    return { id, budget_id: budget, role: 'user' };
  };
  const owner = create('owner');
  const member = create('member',owner.budget_id);
  const other = create('other');
  return {db,owner,member,other};
}

function order(db, user, id = 'order', amount = 100000) {
  db.prepare('INSERT INTO service_payments(id,budget_id,user_id,amount,provider_id,created_at) VALUES (?,?,?,?,?,?)')
    .run(id,user.budget_id,user.id,amount,`bank-${id}`,new Date().toISOString());
  return { OrderId: id, Amount: amount, PaymentId: `bank-${id}`, Status: 'CONFIRMED', Success: true };
}

test('signature rejects tampering, includes scalar fields and ignores nested receipt', () => {
  const data = { TerminalKey:'test-terminal', Amount:10000, Success:true, Receipt:{Email:'test@example.test'} };
  data.Token = paymentToken(data,'test-secret');
  assert.equal(validPaymentToken(data),true);
  assert.equal(validPaymentToken({...data,Amount:10001}),false);
  assert.equal(validPaymentToken({...data,TerminalKey:'another'}),false);
  assert.equal(validPaymentToken(null),false);
});

test('only confirmation credits, repeated and out-of-order notifications do not duplicate money', (t) => {
  const {db,owner,member,other} = setup(t);
  const data = order(db,member);
  applyServicePayment(db,{...data,Status:'AUTHORIZED'});
  assert.equal(serviceBalance(db,owner.budget_id),0);
  assert.equal(applyServicePayment(db,{...data,Amount:1}),false);
  assert.equal(applyServicePayment(db,{...data,PaymentId:'forged'}),false);
  applyServicePayment(db,data); applyServicePayment(db,data);
  applyServicePayment(db,{...data,Status:'AUTHORIZED'});
  assert.equal(serviceInfo(db,owner).balance,100000);
  assert.equal(serviceInfo(db,member).balance,100000);
  assert.equal(serviceInfo(db,other).balance,0);
  applyServicePayment(db,{...data,Status:'REFUNDED'});
  applyServicePayment(db,{...data,Status:'REFUNDED'});
  applyServicePayment(db,data);
  assert.equal(serviceBalance(db,owner.budget_id),0);
});

test('refund arriving before confirmation must prevent a later credit', (t) => {
  const {db,owner} = setup(t); const data = order(db,owner);
  applyServicePayment(db,{...data,Status:'REFUNDED'}); applyServicePayment(db,data);
  assert.equal(serviceBalance(db,owner.budget_id),0);
  assert.equal(serviceInfo(db,owner,data.OrderId).payment.status,'REFUNDED');
});

test('only owner selects plan; charge once, schedule a switch and renew every 30 days', (t) => {
  const {db,owner,member} = setup(t);
  applyServicePayment(db,order(db,member));
  assert.equal(chooseServicePlan(db,member,'plus').status,403);
  assert.equal(chooseServicePlan(db,owner,'invalid').status,400);
  const at = new Date();
  assert.equal(chooseServicePlan(db,owner,'plus',at).ok,true);
  assert.equal(serviceBalance(db,owner.budget_id),85100);
  chooseServicePlan(db,owner,'plus',at);
  assert.equal(serviceBalance(db,owner.budget_id),85100);
  const end = new Date(at.getTime()+30*86400000);
  assert.equal(serviceInfo(db,member).subscription.period_end,end.toISOString());
  assert.equal(chooseServicePlan(db,owner,'premium',at).scheduled,true);
  assert.equal(serviceBalance(db,owner.budget_id),85100);
  assert.equal(renewService(db,new Date(end.getTime()-1)),0);
  assert.equal(renewService(db,end),1);
  assert.equal(serviceBalance(db,owner.budget_id),55200);
  assert.equal(renewService(db,end),0);
  assert.equal(serviceInfo(db,owner).subscription.plan,'premium');
});

test('insufficient balance never overdraws; free cancels renewal while preserving paid time', (t) => {
  const {db,owner} = setup(t);
  assert.equal(chooseServicePlan(db,owner,'premium').status,402);
  assert.equal(serviceBalance(db,owner.budget_id),0);
  applyServicePayment(db,order(db,owner,'small',14900));
  const at = new Date();
  chooseServicePlan(db,owner,'plus',at);
  assert.equal(chooseServicePlan(db,owner,'free',at).scheduled,true);
  assert.equal(planOf(db,owner.budget_id).id,'plus');
  assert.equal(renewService(db,new Date(at.getTime()+31*86400000)),0);
  assert.equal(serviceBalance(db,owner.budget_id),0);
});

test('beta remains indefinite; admin overrides also stop wallet renewal; demo cannot mutate', async (t) => {
  const {db,owner} = setup(t);
  setPlan(db,owner.budget_id,{plan:'premium',label:'beta'});
  const before = serviceInfo(db,owner).plan;
  migrate(db);
  assert.deepEqual(serviceInfo(db,owner).plan,before);
  assert.equal(before.until,null);
  applyServicePayment(db,order(db,owner));
  chooseServicePlan(db,owner,'plus');
  setPlan(db,owner.budget_id,{plan:'premium',label:'founder'});
  assert.equal(serviceInfo(db,owner).subscription,null);
  db.prepare('UPDATE budgets SET demo=1 WHERE id=?').run(owner.budget_id);
  assert.equal(chooseServicePlan(db,owner,'plus').status,409);
  assert.equal((await startServiceTopup(db,owner,10000)).status,409);
  assert.equal(serviceInfo(db,owner).balance,0);
});

test('topup is available to member; returning from checkout alone never credits money', async (t) => {
  const {db,member} = setup(t);
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async (url, options) => {
    assert.equal(url,'https://securepay.tinkoff.ru/v2/Init');
    const data = JSON.parse(options.body);
    assert.equal(data.Amount,29900);
    assert.equal(data.Token,paymentToken(data,'test-secret'));
    assert.match(data.SuccessURL,/screen=set_balance/);
    return {ok:true,json:async()=>({Success:true,ErrorCode:'0',Amount:29900,PaymentId:'12345',PaymentURL:'https://securepay.tinkoff.ru/test'})};
  };
  assert.equal((await startServiceTopup(db,member,29900)).payment_url,'https://securepay.tinkoff.ru/test');
  assert.equal(serviceBalance(db,member.budget_id),0);
  assert.equal((await startServiceTopup(db,member,0)).status,400);
  assert.equal((await startServiceTopup(db,member,100.5)).status,400);
});

test('last member cannot delete a budget with money; failed financial transaction rolls back', (t) => {
  const {db,other} = setup(t);
  applyServicePayment(db,order(db,other));
  assert.equal(deleteAccount(db,other.id).status,409);
  db.exec("CREATE TRIGGER reject_service_update BEFORE UPDATE ON budgets BEGIN SELECT RAISE(ABORT,'test'); END;");
  assert.throws(()=>chooseServicePlan(db,other,'plus'),/test/);
  assert.equal(serviceBalance(db,other.budget_id),100000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM service_subscriptions').get().n,0);
});

test('FNS receipt calls belong to the budget; shared authentication is not falsely attributed', async (t) => {
  const {db,owner,other} = setup(t);
  process.env.FNS_MASTER_TOKEN='test';
  process.env.FNS_AUTH_URL='https://fns.example.test/auth';
  process.env.FNS_KKT_URL='https://fns.example.test/kkt';
  const oldFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=oldFetch;});
  globalThis.fetch=async (url,options)=>({ok:true,text:async()=> url.endsWith('/auth')
    ? '<Token>test-session</Token><ExpireTime>2099-01-01T00:00:00Z</ExpireTime>'
    : options.body.includes('SendMessageRequest') ? '<MessageId>message</MessageId>' : '<ProcessingStatus>PROCESSING</ProcessingStatus>'});
  await requestTicket(db,{sum:100,date:'2026-10-31T12:00:00',fn:'1',fd:1,fp:1,type:1},owner.budget_id);
  await fetchTicket(db,'message',owner.budget_id);
  assert.equal(serviceInfo(db,owner).usage.fns_calls,2);
  assert.equal(serviceInfo(db,other).usage.fns_calls,0);
  assert.equal(db.prepare('SELECT calls FROM fns_usage').get().calls,3);
});

test('expired subscriptions fall back to free, do not charge arrears and recover after topup', (t) => {
  const {db,owner} = setup(t);
  applyServicePayment(db,order(db,owner,'initial',14900));
  chooseServicePlan(db,owner,'plus',new Date(Date.now()-40*86400000));
  assert.equal(planOf(db,owner.budget_id).id,'free');
  assert.equal(renewService(db),0);
  assert.equal(serviceBalance(db,owner.budget_id),0);
  applyServicePayment(db,order(db,owner,'refill',14900));
  const at=new Date();
  assert.equal(renewService(db,at),1);
  assert.equal(serviceBalance(db,owner.budget_id),0);
  assert.equal(serviceInfo(db,owner).subscription.period_end,new Date(at.getTime()+30*86400000).toISOString());
});

test('DEMO payments and simulated plans cannot change real money or actual access', (t) => {
  const {db,owner} = setup(t);
  setPlan(db,owner.budget_id,{plan:'premium',label:'beta'});
  process.env.SERVICE_BILLING_MODE='test';
  process.env.TBANK_ACQUIRING_TERMINAL='test-terminalDEMO';
  t.after(()=>{process.env.SERVICE_BILLING_MODE='live';process.env.TBANK_ACQUIRING_TERMINAL='test-terminal';});
  const data=order(db,owner,'demo',100000);
  db.prepare("UPDATE service_payments SET mode='test' WHERE id='demo'").run();
  applyServicePayment(db,data);
  assert.equal(serviceInfo(db,owner).test_mode,true);
  assert.equal(serviceBalance(db,owner.budget_id),100000);
  assert.equal(serviceBalance(db,owner.budget_id,'live'),0);
  const realOrder=order(db,owner,'live-order',100000);
  assert.equal(applyServicePayment(db,realOrder),false);
  chooseServicePlan(db,owner,'plus');
  assert.equal(serviceInfo(db,owner).plan.id,'plus');
  assert.equal(planOf(db,owner.budget_id).id,'premium');
  assert.equal(planOf(db,owner.budget_id).label,'beta');
  assert.equal(serviceBalance(db,owner.budget_id),85100);
  process.env.SERVICE_BILLING_MODE='live';
  process.env.TBANK_ACQUIRING_TERMINAL='test-terminal';
  assert.equal(serviceInfo(db,owner).plan.id,'premium');
  assert.equal(serviceInfo(db,owner).subscription,null);
  assert.equal(serviceInfo(db,owner).balance,0);
});
