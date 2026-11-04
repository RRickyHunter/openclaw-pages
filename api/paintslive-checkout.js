const Stripe = require('stripe');
const PRICE_ID = 'price_1UYC6lEnlub9vBJKkZXO2ONs';
module.exports = async (req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
 const key=process.env.STRIPE_VMO_SECRET_KEY;
 if(!key) return res.status(503).json({error:'VMO Stripe credentials not configured'});
 try{
  const stripe=new Stripe(key);
  const price=await stripe.prices.retrieve(PRICE_ID,{expand:['product']});
  if(!price.active||price.currency!=='eur'||price.unit_amount!==999||price.product?.metadata?.product_key!=='paintslive') throw Error('PAINTS Live price validation failed');
  const origin='https://pages.riccardoromano.biz';
  const session=await stripe.checkout.sessions.create({mode:'payment',line_items:[{price:PRICE_ID,quantity:1}],success_url:origin+'/paintslive-grazie?session_id={CHECKOUT_SESSION_ID}',cancel_url:origin+'/wspaintslive?pagamento=annullato',billing_address_collection:'auto',customer_creation:'always',metadata:{product_key:'paintslive',product_name:'paintslive',event_date:'2026-11-16',event_time:'18:15'}});
  return res.status(200).json({url:session.url});
 }catch(e){console.error('PAINTS Live checkout:',e.message);return res.status(500).json({error:'Checkout unavailable'});}
};
