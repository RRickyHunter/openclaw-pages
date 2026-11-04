const Stripe = require('stripe');
const PRICE_ID='price_1UYC6lEnlub9vBJKkZXO2ONs';
const TAG_ID='157';
export const config={api:{bodyParser:false}};
async function readRaw(req){const chunks=[];for await(const chunk of req)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));return Buffer.concat(chunks);}
async function ac(path,method='GET',body){
 const base=(process.env.ACTIVECAMPAIGN_API_URL||'https://riccardoromano.api-us1.com/api/3').replace(/\/$/,'');
 const key=process.env.ACTIVECAMPAIGN_API_KEY;
 if(!key)throw Error('ActiveCampaign API key missing');
 const r=await fetch(base+path,{method,headers:{'Api-Token':key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const text=await r.text();let data={};try{data=JSON.parse(text)}catch{}
 if(!r.ok)throw Error('AC '+path+': '+r.status+' '+String(data.message||''));
 return data;
}
async function fieldMap(){const keys=['Data Acquisto','Ultimo Prodotto Acquistato','Valore Ultimo Prodotto Acquistato'];const result={};for(let offset=0;offset<1000;offset+=100){const d=await ac('/fields?limit=100&offset='+offset);for(const f of d.fields||[])if(keys.includes(f.title))result[f.title]=String(f.id);if((d.fields||[]).length<100)break;}return result;}
async function upsertFields(id,fields,values){
 const current=await ac('/contacts/'+id+'/fieldValues');
 const existing=new Map((current.fieldValues||[]).map(v=>[String(v.field),v]));
 for(const [name,value] of Object.entries(values)){
  const field=fields[name];if(!field)continue;
  const old=existing.get(field);
  const payload={fieldValue:{contact:String(id),field,value:String(value)}};
  if(old)await ac('/fieldValues/'+old.id,'PUT',payload);else await ac('/fieldValues','POST',payload);
 }
}
async function sync(session){
 const email=session.customer_details?.email||session.customer_email;
 if(!email)throw Error('Paid checkout has no email');
 const fullName=(session.customer_details?.name||'').trim();
 const parts=fullName.split(/\s+/).filter(Boolean);
 const firstName=parts.length>1?parts.slice(0,-1).join(' '):(parts[0]||'');
 const lastName=parts.length>1?parts.at(-1):'';
 const found=await ac('/contacts?email='+encodeURIComponent(email));
 let contact=found.contacts?.[0];
 if(!contact){
  const created=await ac('/contacts','POST',{contact:{email,firstName,lastName,phone:session.customer_details?.phone||''}});
  contact=created.contact;
 }
 if(!contact?.id)throw Error('AC contact missing');
 const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Atlantic/Canary',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(session.created*1000));
 await upsertFields(contact.id,await fieldMap(),{'Data Acquisto':date,'Ultimo Prodotto Acquistato':'paintslive','Valore Ultimo Prodotto Acquistato':'9.99'});
 const tags=await ac('/contacts/'+contact.id+'/contactTags');
 if(!(tags.contactTags||[]).some(t=>String(t.tag)===TAG_ID)){
  try{await ac('/contactTags','POST',{contactTag:{contact:String(contact.id),tag:TAG_ID}})}
  catch(e){if(!String(e.message).toLowerCase().includes('duplicate'))throw e}
 }
 return contact.id;
}
export default async function handler(req,res){
 if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
 const secret=process.env.STRIPE_VMO_WEBHOOK_SECRET;
 const key=process.env.STRIPE_VMO_SECRET_KEY||process.env.STRIPE_LIVE_SECRET_KEY;
 if(!secret||!key)return res.status(503).json({error:'Webhook not configured'});
 let event;
 try{event=new Stripe(key).webhooks.constructEvent(await readRaw(req),req.headers['stripe-signature'],secret)}
 catch(e){return res.status(400).json({error:'Invalid Stripe signature'});}
 if(event.type!=='checkout.session.completed'&&event.type!=='checkout.session.async_payment_succeeded')return res.status(200).json({received:true,ignored:true});
 const session=event.data.object;
 if(session.payment_status!=='paid')return res.status(200).json({received:true,pending:true});
 if(session.metadata?.product_key!=='paintslive')return res.status(200).json({received:true,ignored:true});
 try{
  const stripe=new Stripe(key);
  const account=await stripe.accounts.retrieve();
  if(account.id!=='acct_1EcgVDEnlub9vBJK')throw Error('Stripe account is not VideoMakingOnline');
  const items=await stripe.checkout.sessions.listLineItems(session.id,{limit:20});
  if(!items.data.some(i=>i.price?.id===PRICE_ID))throw Error('Unexpected product price');
  const contactId=await sync(session);
  return res.status(200).json({received:true,contactId});
 }catch(e){console.error('PAINTS Live webhook failure:',e.message);return res.status(500).json({error:'Webhook processing failed'});}
}
