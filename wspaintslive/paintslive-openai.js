/* OpenAI Ads tracking for PAINTS Live. Only after the existing cookie consent. */
(function () {
  'use strict';
  const pixelId = '94f7VqL4fQrf6Q46pZPxnm';
  const consentKey = 'paintslive_meta_consent_v1';
  const page = location.pathname.replace(/\/+$/, '');
  let started = false, pageSent = false, pending = false;

  function consent() {
    try { return localStorage.getItem(consentKey) === 'yes'; }
    catch (e) { return false; }
  }
  function init() {
    if (!consent()) return false;
    if (!window.oaiq) {
      (function(w,d,s,u) {
        if (w.oaiq) return;
        const q = function(){ q.q.push(arguments); };
        q.q = []; w.oaiq = q;
        const js = d.createElement(s); js.async = true; js.src = u;
        const first = d.getElementsByTagName(s)[0]; first.parentNode.insertBefore(js, first);
      })(window,document,'script','https://bzrcdn.openai.com/sdk/oaiq.min.js');
    }
    // Follow the documented order: set initial denial, initialize, then grant
    // the consent that the visitor has already provided in the site's banner.
    if (!started) {
      window.oaiq('consent', false);
      const options = {pixelId: pixelId};
      if (new URLSearchParams(location.search).get('oai_debug') === '1') options.debug = true;
      window.oaiq('init', options);
      started = true;
    }
    window.oaiq('consent', true);
    return true;
  }
  function pageView() {
    if (pageSent || !init()) return;
    pageSent = true;
    window.oaiq('measure','page_viewed',{
      type:'contents',contents:[{id:'paintslive',name:'PAINTS Live workshop',content_type:'page'}]
    });
  }
  async function paidOrder() {
    if (pending || !consent()) return;
    const sessionId = new URLSearchParams(location.search).get('session_id');
    if (!sessionId) return;
    pending = true;
    try {
      const response = await fetch('/api/paintslive-verify-payment?session_id='+encodeURIComponent(sessionId),
        {method:'GET',cache:'no-store',credentials:'same-origin'});
      if (!response.ok) return;
      const order = await response.json();
      if (order.paid !== true || !Number.isInteger(order.amount) ||
          order.currency !== 'EUR' || typeof order.event_id !== 'string') return;
      const key = 'paintslive_openai_purchase_'+order.event_id;
      try { if (localStorage.getItem(key) === 'sent') return; } catch(e) {}
      if (!init()) return;
      window.oaiq('measure','order_created',{
        type:'contents',amount:order.amount,currency:order.currency,
        contents:[{id:'paintslive',name:'PAINTS Live workshop',content_type:'product',quantity:1}]
      },{event_id:order.event_id});
      try { localStorage.setItem(key,'sent'); } catch(e) {}
    } catch(e) {
      console.warn('OpenAI Ads: impossibile verificare il pagamento.');
    } finally { pending = false; }
  }
  window.paintsliveOpenAIConsentChanged = function(granted) {
    if (!granted) { if (window.oaiq) window.oaiq('consent',false); return; }
    if (page === '/wspaintslive') pageView();
    if (page === '/paintslive-grazie') paidOrder();
  };
  if (page === '/wspaintslive') pageView();
  if (page === '/paintslive-grazie') paidOrder();
})();
