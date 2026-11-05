const Stripe = require('stripe');
const LIVE_PRICE_ID='price_1UYC6lEnlub9vBJKkZXO2ONs';
const TEST_PRICE_ID='price_1UYCQMEnlub9vBJKw7vSXxks';
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
// Same ActiveCampaign contact, purchase-field and tag operations as the OCAE fulfillment flow.
// PAINTS Live deliberately has NO CourseSprout fulfillment.
async function allFields(){
 const all=[];
 for(let offset=0;offset<10000;offset+=100){
  const response=await ac('/fields?limit=100&offset='+offset);
  const chunk=response.fields||[];
  all.push(...chunk);
  if(chunk.length<100)break;
 }
 return all;
}
async function fieldMap(){
 const wanted=new Set(['Address','Country','Città','Provincia','CAP','Data Acquisto','Ultimo Prodotto Acquistato','Valore Ultimo Prodotto Acquistato','LTV']);
 const result={};
 for(const field of await allFields()){if(wanted.has(field.title))result[field.title]=String(field.id)}
 return result;
}
async function upsertFields(contactId,fields,values){
 const current=await ac('/contacts/'+contactId+'/fieldValues');
 const existing=new Map((current.fieldValues||[]).map(v=>[String(v.field),v]));
 for(const [title,value] of Object.entries(values)){
  const fieldId=fields[title];
  if(!fieldId)continue;
  const old=existing.get(String(fieldId));
  const payload={fieldValue:{contact:String(contactId),field:String(fieldId),value:String(value??'')}};
  if(old)await ac('/fieldValues/'+old.id,'PUT',payload);
  else await ac('/fieldValues','POST',payload);
 }
}
function purchaseDate(ts){
 const date=new Date((ts||Math.floor(Date.now()/1000))*1000);
 const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Atlantic/Canary',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(date);
 const get=k=>parts.find(x=>x.type===k)?.value||'00';
 return get('year')+'-'+get('month')+'-'+get('day')+' '+get('hour')+':'+get('minute')+':'+get('second');
}
async function findPurchaseTagId(){
 const name='RR-Acquisto-WS-PAINTSLIVE';
 const r=await ac('/tags?search='+encodeURIComponent(name));
 const match=(r.tags||[]).find(x=>x.tag===name);
 if(!match)throw Error('ActiveCampaign PAINTS Live tag not found');
 return String(match.id);
}
async function upsertContact(session){
 const md=session.metadata||{};
 const cd=session.customer_details||{};
 const address=cd.address||{};
 const email=cd.email||session.customer_email;
 if(!email)throw Error('Paid checkout has no email');
 const name=(cd.name||'').trim();
 const parts=name.split(/\s+/).filter(Boolean);
 const firstName=parts.length>1?parts.slice(0,-1).join(' '):(parts[0]||md.first_name||'');
 const lastName=parts.length>1?parts[parts.length-1]:(md.last_name||'');
 const customer={
  email,firstName,lastName,phone:cd.phone||md.phone||'',
  country:md.country||address.country||'',
  address:md.address||[address.line1,address.line2].filter(Boolean).join(' ').trim(),
  city:md.city||address.city||'',
  state:md.state||address.state||'',
  postalCode:md.postal_code||address.postal_code||''
 };
 const found=await ac('/contacts?email='+encodeURIComponent(customer.email));
 let contact=found.contacts?.[0];
 const payload={contact:{email:customer.email,firstName:customer.firstName,lastName:customer.lastName,phone:String(customer.phone).trim()}};
 if(contact){
  // Preserve previously known personal data when Stripe provides no new value.
  payload.contact.firstName=customer.firstName||contact.firstName||'';
  payload.contact.lastName=customer.lastName||contact.lastName||'';
  payload.contact.phone=String(customer.phone||contact.phone||'').trim();
  const updated=await ac('/contacts/'+contact.id,'PUT',payload);
  contact=updated.contact||contact;
 }else{
  const created=await ac('/contacts','POST',payload);
  contact=created.contact;
 }
 if(!contact?.id)throw Error('AC contact upsert failed');
 return {contact,customer};
}
async function sync(session){
 const {contact,customer}=await upsertContact(session);
 const fields=await fieldMap();
 await upsertFields(contact.id,fields,{
  'Address':customer.address,
  'Country':customer.country,
  'Città':customer.city,
  'Provincia':customer.state,
  'CAP':customer.postalCode,
  'Data Acquisto':purchaseDate(session.created),
  'Ultimo Prodotto Acquistato':'paintslive',
  'Valore Ultimo Prodotto Acquistato':String((session.amount_total||999)/100)
 });
 // Apply tag AFTER contact and purchase fields are saved, matching the OCAE flow.
 // Existing tags are preserved. Repeated Stripe notifications do not retrigger AC.
 const tagId=await findPurchaseTagId();
 const tags=await ac('/contacts/'+contact.id+'/contactTags');
 if(!(tags.contactTags||[]).some(x=>String(x.tag)===tagId)){
  try{await ac('/contactTags','POST',{contactTag:{contact:String(contact.id),tag:tagId}})}
  catch(error){if(!String(error.message).toLowerCase().includes('duplicate'))throw error}
 }
 return {contactId:contact.id,tagName:'RR-Acquisto-WS-PAINTSLIVE'};
}
export default async function handler(req,res){
 if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
 const test=process.env.VERCEL_ENV!=='production'&&process.env.STRIPE_MODE==='test';
 const secret=test?process.env.STRIPE_VMO_TEST_WEBHOOK_SECRET:process.env.STRIPE_VMO_WEBHOOK_SECRET;
 const key=test?process.env.STRIPE_TEST_SECRET_KEY:(process.env.STRIPE_VMO_SECRET_KEY||process.env.STRIPE_LIVE_SECRET_KEY);
 const expectedPrice=test?TEST_PRICE_ID:LIVE_PRICE_ID;
 if(!secret||!key)return res.status(503).json({error:'Webhook not configured'});
 let event;
 try{event=new Stripe(key).webhooks.constructEvent(await readRaw(req),req.headers['stripe-signature'],secret)}
 catch(e){return res.status(400).json({error:'Invalid Stripe signature'});}
 if(event.type!=='checkout.session.completed'&&event.type!=='checkout.session.async_payment_succeeded')return res.status(200).json({received:true,ignored:true});
 const session=event.data.object;
 if(session.payment_status!=='paid')return res.status(200).json({received:true,pending:true});
 if(session.metadata?.product_key!=='paintslive')return res.status(200).json({received:true,ignored:true});
 if(session.livemode===test)return res.status(400).json({error:'Wrong Stripe mode'});
 try{
  const stripe=new Stripe(key);
  const account=await stripe.accounts.retrieve();
  if(account.id!=='acct_1EcgVDEnlub9vBJK')throw Error('Stripe account is not VideoMakingOnline');
  const items=await stripe.checkout.sessions.listLineItems(session.id,{limit:20});
  if(!items.data.some(i=>i.price?.id===expectedPrice))throw Error('Unexpected product price');
  if(test)return res.status(200).json({received:true,validated:true,activeCampaignSkipped:true});
  const result=await sync(session);
  return res.status(200).json({received:true,contactId:result.contactId,tagApplied:result.tagName});
 }catch(e){console.error('PAINTS Live webhook failure:',e.message);return res.status(500).json({error:'Webhook processing failed'});}
}
