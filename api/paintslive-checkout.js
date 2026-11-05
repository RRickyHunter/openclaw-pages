const Stripe = require('stripe');
const ACCOUNT_ID='acct_1EcgVDEnlub9vBJK';
const LIVE_PRICE_ID='price_1UYC6lEnlub9vBJKkZXO2ONs';
const TEST_PRICE_ID='price_1UYCQMEnlub9vBJKw7vSXxks';
module.exports=async (req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
 const test=(process.env.STRIPE_MODE||'live').toLowerCase()==='test' && process.env.VERCEL_ENV!=='production';
 const key=test?process.env.STRIPE_TEST_SECRET_KEY:(process.env.STRIPE_VMO_SECRET_KEY||process.env.STRIPE_LIVE_SECRET_KEY);
 const priceId=test?TEST_PRICE_ID:LIVE_PRICE_ID;
 if(!key)return res.status(503).json({error:'Stripe credentials not configured'});
 if(!test&&(!process.env.STRIPE_VMO_WEBHOOK_SECRET||!process.env.ACTIVECAMPAIGN_API_KEY))return res.status(503).json({error:'Workshop purchase activation not configured'});
 try{
  const stripe=new Stripe(key);
  const account=await stripe.accounts.retrieve();
  if(account.id!==ACCOUNT_ID)throw Error('Stripe account is not VideoMakingOnline');
  const price=await stripe.prices.retrieve(priceId,{expand:['product']});
  if(!price.active||price.currency!=='eur'||price.unit_amount!==999||price.product?.metadata?.product_key!=='paintslive'||price.livemode===test)throw Error('PAINTS Live price validation failed');
  const host=(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim().toLowerCase();
  const safePreview=/^openclaw-pages-[a-z0-9]+-riccardoromano\.vercel\.app$/.test(host);
  const origin=(test&&safePreview)?'https://'+host:'https://pages.riccardoromano.biz';
  const session=await stripe.checkout.sessions.create({
   mode:'payment',
   line_items:[{price:priceId,quantity:1}],
   success_url:origin+'/paintslive-grazie?session_id={CHECKOUT_SESSION_ID}',
   cancel_url:origin+'/wspaintslive?pagamento=annullato',
   billing_address_collection:'auto',customer_creation:'always',
   metadata:{product_key:'paintslive',product_name:'paintslive',event_date:'2026-11-16',event_time:'18:15',event_timezone:'Europe/Rome'}
  });
  return res.status(200).json({url:session.url});
 }catch(e){console.error('PAINTS Live checkout:',e.message);return res.status(500).json({error:'Checkout unavailable'});}
};
