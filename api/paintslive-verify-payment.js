// Confirm a paid PAINTS Live Stripe Checkout session before browser-side measurement.
// Read only: does not fulfill purchases, expose customer information, or send CAPI events.
const crypto = require('crypto');
const Stripe = require('stripe');
const ACCOUNT_ID = 'acct_1EcgVDEnlub9vBJK';
const LIVE_PRICE_ID = 'price_1UYC6lEnlub9vBJKkZXO2ONs';
const TEST_PRICE_ID = 'price_1UYCQMEnlub9vBJKw7vSXxks';

module.exports = async (req,res) => {
  res.setHeader('Cache-Control','no-store, max-age=0');
  if (req.method !== 'GET') return res.status(405).json({error:'Method not allowed'});
  const sessionId = req.query && req.query.session_id;
  if (typeof sessionId !== 'string' ||
      !/^cs_(?:test|live)_[A-Za-z0-9]{10,}$/.test(sessionId)) {
    return res.status(400).json({error:'Invalid session'});
  }
  const test = (process.env.STRIPE_MODE || 'live').toLowerCase() === 'test' &&
    process.env.VERCEL_ENV !== 'production';
  const key = test ? process.env.STRIPE_TEST_SECRET_KEY :
    (process.env.STRIPE_VMO_SECRET_KEY || process.env.STRIPE_LIVE_SECRET_KEY);
  if (!key) return res.status(503).json({error:'Verification unavailable'});
  try {
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid' || session.metadata?.product_key !== 'paintslive' ||
        session.livemode === test || session.currency !== 'eur' ||
        !Number.isInteger(session.amount_total)) {
      return res.status(404).json({error:'Paid order not found'});
    }
    const account = await stripe.accounts.retrieve();
    if (account.id !== ACCOUNT_ID) throw Error('Unexpected Stripe account');
    const items = await stripe.checkout.sessions.listLineItems(session.id,{limit:20});
    if (!items.data.some(item => item.price?.id === (test ? TEST_PRICE_ID : LIVE_PRICE_ID))) {
      return res.status(404).json({error:'Paid order not found'});
    }
    const digest = crypto.createHash('sha256').update(session.id).digest('hex');
    return res.status(200).json({
      paid:true,amount:session.amount_total,currency:'EUR',event_id:'paintslive_'+digest
    });
  } catch (error) {
    if (error?.type === 'StripeInvalidRequestError') {
      return res.status(404).json({error:'Paid order not found'});
    }
    console.error('PAINTS Live verification:',error.message);
    return res.status(503).json({error:'Verification unavailable'});
  }
};
