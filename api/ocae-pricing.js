const TZ = 'Europe/Rome';
const DEFAULT_CURRENCY = 'EUR';
const STRIPE_MODE = (process.env.STRIPE_MODE || 'test').toLowerCase();

const SCHEDULE = [
  {
    key: 'launch-497',
    startsAt: null,
    endsAt: '2026-06-21T23:59:59+02:00',
    price: 497,
    compareAtPrice: 1497,
    timerVisible: true,
    stripePriceId: {
      live: 'price_1TPXYfEnlub9vBJKuiqof4Aa',
      test: 'price_1TjdxJEnlub9vBJKTn0xRF8p',
    },
    ctaLabel: 'Accedi subito',
  },
  {
    key: 'post-deadline-547',
    startsAt: '2026-06-22T00:00:00+02:00',
    endsAt: '2026-06-28T23:59:59+02:00',
    price: 547,
    compareAtPrice: 1497,
    timerVisible: true,
    stripePriceId: {
      live: 'price_1TjdMuEnlub9vBJKFcGrKxNl',
      test: 'price_1TjdxJEnlub9vBJKYaxJO8tc',
    },
    ctaLabel: 'Accedi subito',
  },
  {
    key: 'webinar-offer-647',
    startsAt: '2026-07-14T00:00:00+02:00',
    endsAt: '2026-09-20T23:59:59+02:00',
    price: 647,
    compareAtPrice: 1497,
    timerVisible: true,
    stripePriceId: {
      live: 'price_1U2w6kEnlub9vBJKKZ1oRohJ',
      test: 'price_1TjdxJEnlub9vBJKYaxJO8tc',
    },
    ctaLabel: 'Accedi subito',
  },
];

const POST_OFFER_DEFAULT = {
  key: 'post-offer-full-1497',
  startsAt: '2026-09-21T00:00:00+02:00',
  endsAt: null,
  price: 1497,
  compareAtPrice: null,
  timerVisible: false,
  stripePriceId: null,
  ctaLabel: 'Accedi subito',
};

function toMillis(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Invalid schedule datetime: ${value}`);
  return ms;
}

function getActiveWindow(nowMs = Date.now()) {
  return (
    SCHEDULE.find((entry) => {
      const startsAt = toMillis(entry.startsAt);
      const endsAt = toMillis(entry.endsAt);
      if (startsAt !== null && nowMs < startsAt) return false;
      if (endsAt !== null && nowMs > endsAt) return false;
      return true;
    }) || POST_OFFER_DEFAULT
  );
}

function resolveStripePriceId(entry) {
  if (!entry || !entry.stripePriceId) return null;
  if (typeof entry.stripePriceId === 'string') return entry.stripePriceId;
  return entry.stripePriceId[STRIPE_MODE] || entry.stripePriceId.test || entry.stripePriceId.live || null;
}

function buildResponse(nowMs = Date.now()) {
  const active = getActiveWindow(nowMs);
  const next = SCHEDULE.find((entry) => {
    const startsAt = toMillis(entry.startsAt);
    return startsAt !== null && startsAt > nowMs;
  }) || null;

  return {
    timezone: TZ,
    now: new Date(nowMs).toISOString(),
    mode: STRIPE_MODE,
    checkoutPath: '/ocaeckout',
    salesPath: '/ocae',
    active: {
      key: active.key,
      price: active.price,
      compareAtPrice: active.compareAtPrice,
      currency: DEFAULT_CURRENCY,
      stripePriceId: resolveStripePriceId(active),
      ctaLabel: active.ctaLabel,
      endsAt: active.endsAt,
      startsAt: active.startsAt,
      timerVisible: active.timerVisible !== false,
    },
    next: next
      ? {
          key: next.key,
          price: next.price,
          stripePriceId: resolveStripePriceId(next),
          startsAt: next.startsAt,
        }
      : null,
    schedule: SCHEDULE.map((entry) => ({
      key: entry.key,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      price: entry.price,
      stripePriceId: resolveStripePriceId(entry),
    })),
  };
}

function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = buildResponse();
  res.setHeader('Cache-Control', 'no-store, max-age=0, s-maxage=0');
  return res.status(200).json(payload);
}

export default handler;
export { buildResponse, SCHEDULE };
