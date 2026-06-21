const ACTIVE_CAMPAIGN_API_URL = process.env.ACTIVECAMPAIGN_API_URL || 'https://riccardoromano.api-us1.com/api/3';
const ACTIVE_CAMPAIGN_API_KEY = process.env.ACTIVECAMPAIGN_API_KEY;
const WEBINAR_TAG_ID = process.env.ACTIVECAMPAIGN_WEBINAR_TAG_ID || '148';
const WEBINAR_AUTOMATION_ID = process.env.ACTIVECAMPAIGN_WEBINAR_AUTOMATION_ID || '116';
const PRIVACY_FIELD_ID = process.env.ACTIVECAMPAIGN_PRIVACY_FIELD_ID || '13';
const UPDATES_FIELD_ID = process.env.ACTIVECAMPAIGN_UPDATES_FIELD_ID || '64';
const TURNSTILE_SECRET_KEY = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET_KEY || '';
const PRIVACY_TEXT = 'Ho letto l’Informativa Privacy e acconsento al trattamento dei miei dati personali per gestire la mia iscrizione al webinar.';
const UPDATES_TEXT = 'Acconsento a ricevere via email contenuti e aggiornamenti sulle attività di Riccardo Romano';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  try {
    const payload = normalizePayload(req.body);
    const name = sanitizeText(payload.name || '');
    const email = sanitizeEmail(payload.email || '');
    const privacyAccepted = toBoolean(payload.privacyAccepted);
    const updatesAccepted = toBoolean(payload.updatesAccepted);
    const turnstileToken = sanitizeToken(
      payload.turnstileToken || payload.cfTurnstileResponse || payload['cf-turnstile-response'] || ''
    );

    if (!name || !email) {
      return res.status(400).json({ ok: false, message: 'Inserisci nome ed email.' });
    }

    if (!privacyAccepted) {
      return res.status(400).json({ ok: false, message: 'Devi accettare l’informativa privacy per iscriverti.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, message: 'Inserisci una mail valida.' });
    }

    if (!TURNSTILE_SECRET_KEY) {
      return res.status(500).json({ ok: false, message: 'Captcha non configurato.' });
    }

    if (!turnstileToken) {
      return res.status(400).json({ ok: false, message: 'Completa il captcha prima di inviare il modulo.' });
    }

    const turnstileVerification = await verifyTurnstileToken(turnstileToken, req);
    if (!turnstileVerification.success) {
      return res.status(400).json({
        ok: false,
        message: 'Verifica captcha non riuscita. Riprova.',
        code: turnstileVerification['error-codes'] || []
      });
    }

    if (!ACTIVE_CAMPAIGN_API_KEY) {
      return res.status(500).json({ ok: false, message: 'Integrazione ActiveCampaign non configurata.' });
    }

    const [firstName, ...rest] = name.split(/\s+/).filter(Boolean);
    const lastName = rest.join(' ');

    const syncResponse = await fetch(`${ACTIVE_CAMPAIGN_API_URL}/contact/sync`, {
      method: 'POST',
      headers: {
        'Api-Token': ACTIVE_CAMPAIGN_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        contact: {
          email,
          firstName: firstName || name,
          lastName: lastName || ''
        }
      })
    });

    if (!syncResponse.ok) {
      const body = await syncResponse.text().catch(() => '');
      throw new Error(`sync_failed_${syncResponse.status}:${body}`);
    }

    const syncData = await syncResponse.json();
    const contactId = syncData?.contact?.id;

    if (!contactId) {
      throw new Error('missing_contact_id');
    }

    await upsertFieldValue(contactId, PRIVACY_FIELD_ID, PRIVACY_TEXT);
    if (updatesAccepted) {
      await upsertFieldValue(contactId, UPDATES_FIELD_ID, UPDATES_TEXT);
    }
    await ensureContactTag(contactId);
    await enrollContactInAutomation(contactId);

    return res.status(200).json({ ok: true, message: 'Iscrizione completata.' });
  } catch (error) {
    console.error('[webinar-register]', error?.message || error);
    return res.status(500).json({ ok: false, message: 'Errore temporaneo. Riprova tra poco.' });
  }
}

function normalizePayload(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    return Object.fromEntries(new URLSearchParams(body).entries());
  }
  if (body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries());
  }
  return body;
}

function sanitizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

function sanitizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 160);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function toBoolean(value) {
  return value === true || value === 'true' || value === '1' || value === 1 || value === 'on';
}

function sanitizeToken(value) {
  return String(value || '').trim().slice(0, 2048);
}

async function verifyTurnstileToken(token, req) {
  const remoteip = getRemoteIp(req);
  const body = new URLSearchParams({
    secret: TURNSTILE_SECRET_KEY,
    response: token
  });

  if (remoteip) {
    body.set('remoteip', remoteip);
  }

  const response = await fetch(TURNSTILE_VERIFY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: body.toString()
  });

  if (!response.ok) {
    const verifyBody = await response.text().catch(() => '');
    throw new Error(`turnstile_verify_failed_${response.status}:${verifyBody}`);
  }

  return response.json();
}

function getRemoteIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
}

async function upsertFieldValue(contactId, fieldId, value) {
  if (!contactId || !fieldId || !value) return;

  const response = await fetch(`${ACTIVE_CAMPAIGN_API_URL}/fieldValues`, {
    method: 'POST',
    headers: {
      'Api-Token': ACTIVE_CAMPAIGN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      fieldValue: {
        contact: String(contactId),
        field: String(fieldId),
        value: String(value)
      }
    })
  });

  if (!response.ok && response.status !== 409) {
    const body = await response.text().catch(() => '');
    throw new Error(`field_failed_${fieldId}_${response.status}:${body}`);
  }
}

async function ensureContactTag(contactId) {
  if (!contactId || !WEBINAR_TAG_ID) return;

  const response = await fetch(`${ACTIVE_CAMPAIGN_API_URL}/contactTags`, {
    method: 'POST',
    headers: {
      'Api-Token': ACTIVE_CAMPAIGN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      contactTag: {
        contact: String(contactId),
        tag: String(WEBINAR_TAG_ID)
      }
    })
  });

  if (!response.ok && response.status !== 409) {
    const body = await response.text().catch(() => '');
    throw new Error(`tag_failed_${response.status}:${body}`);
  }
}

async function enrollContactInAutomation(contactId) {
  if (!contactId || !WEBINAR_AUTOMATION_ID) return;

  const response = await fetch(`${ACTIVE_CAMPAIGN_API_URL}/contactAutomations`, {
    method: 'POST',
    headers: {
      'Api-Token': ACTIVE_CAMPAIGN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      contactAutomation: {
        contact: String(contactId),
        automation: String(WEBINAR_AUTOMATION_ID)
      }
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`automation_failed_${response.status}:${body}`);
  }
}
