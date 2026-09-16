// Canonical OCAE pricing contract source for Central Page Publisher.
// Runtime /api/ocae-pricing remains a proxy; this file is parsed by the
// ocae-pricing-v1 gate to avoid duplicating pricing values inside the proxy.

const CHECKOUT_PATH = '/ocaeckout';
const SALES_PATH = '/ocae';

const OCAE_PRICING_CONTRACT = {
  key: 'webinar-offer-647',
  endsAt: '2026-09-27T23:59:59+02:00',
  price: 647,
  compareAtPrice: 1497,
  timerVisible: true,
  stripePriceIdLive: 'price_1U2w6kEnlub9vBJKKZ1oRohJ',
  stripePriceIdTest: 'price_1TjdxJEnlub9vBJKYaxJO8tc',
};

export { CHECKOUT_PATH, SALES_PATH, OCAE_PRICING_CONTRACT };
