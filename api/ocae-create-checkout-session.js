const { buildResponse } = require('./ocae-pricing');

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0, s-maxage=0');
  res.end(JSON.stringify(payload));
}

async function createStripeCheckoutSession({ stripeSecretKey, pricingConfig, customer, origin, pricing }) {
  const stripeModule = await import('stripe');
  const Stripe = stripeModule.default;
  const stripe = new Stripe(stripeSecretKey);

  const successUrl = `${origin}/ocaetyorder?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/ocaeckout?cancelled=1`;
  const displayName = 'OpenClaw Activation Experience';
  const productDescription = 'Accesso a OCAE, 1 mese di ClawRoot, minicorso attivazione e gruppo VIP Telegram';
  const productImage = `${origin}/stripe-assets/ocae-stripe-product.jpg`;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'eur',
        unit_amount: Math.round(Number(pricingConfig.price || pricing.basePrice || 0) * 100),
        product_data: {
          name: displayName,
          description: productDescription,
          images: [productImage],
        },
      },
      quantity: 1,
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customer.email,
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: true },
    metadata: {
      product_key: 'ocae',
      product_name: displayName,
      source_path: '/ocaeckout',
      first_name: customer.firstName || '',
      last_name: customer.lastName || '',
      phone: customer.phone || '',
      country: customer.country || '',
      address: customer.address || '',
      city: customer.city || '',
      state: customer.state || '',
      postal_code: customer.postalCode || '',
      tax_label: '0',
      tax_amount: '0',
      base_price: String(pricingConfig.price || pricing.basePrice || 0),
      total_amount: String(pricingConfig.price || pricing.total || pricing.basePrice || 0),
    },
    custom_text: {
      submit: {
        message: 'Pagamento gestito in modo sicuro da Stripe.',
      },
    },
  });

  return session;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed' });
  }

  const pricingResponse = buildResponse();
  const active = pricingResponse.active || {};

  if (typeof active.price !== 'number') {
    return json(res, 500, { error: 'Active price is missing' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const customer = body.customer || {};
  const pricing = body.pricing || {};

  if (!customer.email || !customer.firstName || !customer.lastName || !customer.country) {
    return json(res, 400, { error: 'Missing required customer fields' });
  }

  const stripeMode = (process.env.STRIPE_MODE || 'test').toLowerCase();
  const useLive = stripeMode === 'live';
  const stripeSecretKey = useLive
    ? (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_LIVE_SECRET_KEY || null)
    : (process.env.STRIPE_TEST_SECRET_KEY || null);
  const publishableKey = useLive
    ? (process.env.STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_LIVE_PUBLISHABLE_KEY || null)
    : (process.env.STRIPE_TEST_PUBLISHABLE_KEY || null);

  if (!stripeSecretKey) {
    return json(res, 501, {
      error: 'Stripe secret key not configured for current mode',
      mode: stripeMode,
      missing: [useLive ? 'STRIPE_SECRET_KEY or STRIPE_LIVE_SECRET_KEY' : 'STRIPE_TEST_SECRET_KEY'],
      expectedEndpoint: '/api/ocae-create-checkout-session',
      activePrice: active.price,
    });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = host ? `${proto}://${host}` : 'https://pages.riccardoromano.biz';

  try {
    const session = await createStripeCheckoutSession({
      stripeSecretKey,
      pricingConfig: active,
      customer,
      origin,
      pricing,
    });

    return json(res, 200, {
      ok: true,
      sessionId: session.id,
      url: session.url || null,
      publishableKey,
      pricing: {
        key: active.key,
        price: active.price,
        mode: stripeMode,
        taxAmount: 0,
        total: active.price,
      },
    });
  } catch (error) {
    return json(res, 500, {
      error: 'Stripe checkout session creation failed',
      detail: error && error.message ? error.message : String(error),
    });
  }
};
