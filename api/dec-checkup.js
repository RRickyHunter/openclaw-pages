const REQUIRED_MIN_SUBMIT_MS = 4000;
const ACTIVE_CAMPAIGN_API_URL = process.env.ACTIVECAMPAIGN_API_URL || 'https://riccardoromano.api-us1.com/api/3';
const ACTIVE_CAMPAIGN_API_KEY = process.env.ACTIVECAMPAIGN_API_KEY;
const ACTIVE_CAMPAIGN_LIST_ID = process.env.ACTIVECAMPAIGN_LIST_ID || '2';
const ACTIVE_CAMPAIGN_TAG_ID = process.env.ACTIVECAMPAIGN_TAG_ID || '136';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ACTIVE_CAMPAIGN_FIELD_IDS = {
  quiz_result: process.env.ACTIVECAMPAIGN_FIELD_ID_QUIZ_RESULT || '61',
  qualification_score: process.env.ACTIVECAMPAIGN_FIELD_ID_QUALIFICATION_SCORE || '62',
  quiz_support_level: process.env.ACTIVECAMPAIGN_FIELD_ID_QUIZ_SUPPORT_LEVEL || '60'
};
const MAX_FIELD_LENGTHS = {
  name: 120,
  phone: 40,
  email: 160,
  location: 120,
  goal: 160,
  callback_window: 80,
  notes: 2000,
  quiz_result: 160,
  quiz_profile: 160,
  quiz_support_level: 240,
  source_page: 80,
  source_url: 2048
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  try {
    const rawPayload = normalizePayload(req);
    logEvent('received', { source_page: rawPayload?.source_page || 'unknown' });

    if (isSpamSubmission(rawPayload)) {
      logEvent('spam_blocked', { reason: 'honeypot_filled' });
      return res.status(200).json({
        ok: true,
        message: resolveClientMessage(rawPayload?.qualification_score)
      });
    }

    const payload = sanitizePayload(rawPayload);
    const validationError = validatePayload(payload);

    if (validationError) {
      logEvent('validation_failed', { reason: validationError.reason, fields: validationError.fields });
      return res.status(400).json({
        ok: false,
        message: validationError.message,
        fields: validationError.fields
      });
    }

    const forwarded = await forwardPayload(payload);
    const activeCampaignResult = await upsertActiveCampaignContact(payload);

    if (forwarded) {
      logEvent('forwarded', {
        destination: 'webhook',
        source_page: payload.source_page,
        has_email: Boolean(payload.email),
        has_phone: Boolean(payload.phone)
      });
    }

    if (!activeCampaignResult?.ok) {
      throw new Error(activeCampaignResult?.error || 'activecampaign_failed');
    }

    logEvent('forwarded', {
      destination: 'activecampaign',
      contact_id: activeCampaignResult.contactId,
      source_page: payload.source_page,
      has_email: Boolean(payload.email),
      has_phone: Boolean(payload.phone)
    });

    const telegramResult = await notifyTelegramLead(payload);
    if (!telegramResult?.ok) {
      throw new Error(telegramResult?.error || 'telegram_failed');
    }

    logEvent('forwarded', {
      destination: 'telegram',
      source_page: payload.source_page,
      contact_id: activeCampaignResult.contactId,
      message_id: telegramResult.messageId
    });

    return res.status(200).json({
      ok: true,
      message: resolveClientMessage(payload.qualification_score)
    });
  } catch (error) {
    console.error('[dec-checkup]', JSON.stringify({ event: 'handler_error', message: error?.message || 'Unknown error' }));
    return res.status(500).json({
      ok: false,
      message: 'Errore temporaneo nella ricezione del check-up.'
    });
  }
}

function normalizePayload(req) {
  const body = req.body || {};

  if (typeof body === 'string') {
    const params = new URLSearchParams(body);
    return Object.fromEntries(params.entries());
  }

  if (body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries());
  }

  return body;
}

function sanitizePayload(payload) {
  const sanitized = {};

  for (const [key, value] of Object.entries(payload || {})) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      sanitized[key] = limitLength(key, trimmed);
    } else {
      sanitized[key] = value;
    }
  }

  sanitized.name = sanitizeText(sanitized.name, 'name');
  sanitized.phone = sanitizeText(sanitized.phone, 'phone');
  sanitized.email = sanitizeEmail(sanitized.email);
  sanitized.location = sanitizeText(sanitized.location, 'location');
  sanitized.goal = sanitizeText(sanitized.goal, 'goal');
  sanitized.callback_window = sanitizeText(sanitized.callback_window, 'callback_window');
  sanitized.notes = sanitizeText(sanitized.notes, 'notes');
  sanitized.quiz_result = sanitizeText(sanitized.quiz_result, 'quiz_result');
  sanitized.quiz_profile = sanitizeText(sanitized.quiz_profile, 'quiz_profile');
  sanitized.quiz_support_level = sanitizeText(sanitized.quiz_support_level, 'quiz_support_level');
  sanitized.source_page = sanitizeText(sanitized.source_page, 'source_page');
  sanitized.source_url = sanitizeText(sanitized.source_url, 'source_url');
  sanitized.privacy_consent = normalizeConsent(sanitized.privacy_consent);
  sanitized.qualification_score = normalizeNumber(sanitized.qualification_score);
  sanitized.quiz_score = normalizeNumber(sanitized.quiz_score);
  sanitized.form_started_at = sanitizeText(sanitized.form_started_at, 'form_started_at');
  sanitized.website = sanitizeText(sanitized.website, 'website');

  return sanitized;
}

function validatePayload(payload) {
  const missingFields = [];

  if (!payload.name) missingFields.push('name');
  if (!payload.phone && !payload.email) missingFields.push('phone_or_email');
  if (!payload.privacy_consent) missingFields.push('privacy_consent');

  if (missingFields.length > 0) {
    return {
      reason: 'missing_required',
      fields: missingFields,
      message: 'Compila i campi obbligatori richiesti prima di inviare.'
    };
  }

  if (payload.email && !isValidEmail(payload.email)) {
    return {
      reason: 'invalid_email',
      fields: ['email'],
      message: 'Inserisci un indirizzo email valido oppure lascia solo il telefono.'
    };
  }

  const startedAt = Number(payload.form_started_at || 0);
  if (!Number.isFinite(startedAt) || Date.now() - startedAt < REQUIRED_MIN_SUBMIT_MS) {
    return {
      reason: 'submitted_too_fast',
      fields: ['form_started_at'],
      message: 'Invio non valido. Riprova tra qualche secondo.'
    };
  }

  return null;
}

function isSpamSubmission(payload) {
  return Boolean(String(payload?.website || '').trim());
}

async function forwardPayload(payload) {
  if (!process.env.DEC_CHECKUP_WEBHOOK_URL) {
    console.log('[dec-checkup]', JSON.stringify({ event: 'forwarded', destination: 'local_log_only', payload }));
    return false;
  }

  try {
    const webhookResponse = await fetch(process.env.DEC_CHECKUP_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!webhookResponse.ok) {
      const webhookBody = await webhookResponse.text().catch(() => '');
      console.error('[dec-checkup]', JSON.stringify({
        event: 'webhook_failed',
        status: webhookResponse.status,
        body: webhookBody,
        payload
      }));
      console.log('[dec-checkup]', JSON.stringify({ event: 'webhook_failed_fallback', payload }));
      return false;
    }

    return true;
  } catch (error) {
    console.error('[dec-checkup]', JSON.stringify({
      event: 'webhook_failed',
      message: error?.message || 'Unknown webhook error',
      payload
    }));
    console.log('[dec-checkup]', JSON.stringify({ event: 'webhook_failed_fallback', payload }));
    return false;
  }
}

async function upsertActiveCampaignContact(payload) {
  if (!ACTIVE_CAMPAIGN_API_KEY || !payload.email) {
    if (!ACTIVE_CAMPAIGN_API_KEY) {
      console.log('[dec-checkup]', JSON.stringify({ event: 'activecampaign_skipped', reason: 'missing_api_key' }));
    }
    return { ok: false, skipped: true, error: 'missing_api_key_or_email' };
  }

  const [firstName, ...rest] = String(payload.name || '').trim().split(/\s+/);
  const lastName = rest.join(' ');

  const contactPayload = {
    contact: {
      email: payload.email,
      firstName: firstName || payload.name || '',
      lastName: lastName || '',
      phone: payload.phone || '',
      fieldValues: [
        { field: ACTIVE_CAMPAIGN_FIELD_IDS.quiz_result, value: payload.quiz_result || payload.quiz_profile || '' },
        { field: ACTIVE_CAMPAIGN_FIELD_IDS.qualification_score, value: String(payload.qualification_score ?? '') },
        { field: ACTIVE_CAMPAIGN_FIELD_IDS.quiz_support_level, value: payload.quiz_support_level || '' }
      ]
    }
  };

  const syncResponse = await fetch(`${ACTIVE_CAMPAIGN_API_URL}/contact/sync`, {
    method: 'POST',
    headers: {
      'Api-Token': ACTIVE_CAMPAIGN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(contactPayload)
  });

  if (!syncResponse.ok) {
    const body = await syncResponse.text().catch(() => '');
    console.error('[dec-checkup]', JSON.stringify({ event: 'activecampaign_sync_failed', status: syncResponse.status, body }));
    return { ok: false, error: `sync_failed_${syncResponse.status}` };
  }

  const syncData = await syncResponse.json();
  const contactId = syncData?.contact?.id;

  if (!contactId) {
    return { ok: false, error: 'missing_contact_id' };
  }

  await ensureContactList(contactId);
  await ensureContactTag(contactId);

  return { ok: true, contactId };
}

async function ensureContactList(contactId) {
  if (!contactId || !ACTIVE_CAMPAIGN_LIST_ID) return;

  const listResponse = await fetch(`${ACTIVE_CAMPAIGN_API_URL}/contactLists`, {
    method: 'POST',
    headers: {
      'Api-Token': ACTIVE_CAMPAIGN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      contactList: {
        list: String(ACTIVE_CAMPAIGN_LIST_ID),
        contact: String(contactId),
        status: 1
      }
    })
  });

  if (!listResponse.ok && listResponse.status !== 409) {
    const body = await listResponse.text().catch(() => '');
    throw new Error(`activecampaign_list_failed_${listResponse.status}:${body}`);
  }
}

async function ensureContactTag(contactId) {
  if (!contactId || !ACTIVE_CAMPAIGN_TAG_ID) return;

  const tagResponse = await fetch(`${ACTIVE_CAMPAIGN_API_URL}/contactTags`, {
    method: 'POST',
    headers: {
      'Api-Token': ACTIVE_CAMPAIGN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      contactTag: {
        contact: String(contactId),
        tag: String(ACTIVE_CAMPAIGN_TAG_ID)
      }
    })
  });

  if (!tagResponse.ok && tagResponse.status !== 409) {
    const body = await tagResponse.text().catch(() => '');
    throw new Error(`activecampaign_tag_failed_${tagResponse.status}:${body}`);
  }
}

async function notifyTelegramLead(payload) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { ok: false, error: 'missing_telegram_env' };
  }

  const text = `Dì a Marco e Alessandro che hanno ricevuto un lead! Si chiama ${String(payload.name || '').trim()}`;
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text
    })
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { ok: false, error: `telegram_failed_${resp.status}:${body}` };
  }

  const data = await resp.json().catch(() => null);
  return { ok: true, messageId: data?.result?.message_id || null };
}

function sanitizeText(value, key) {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return limitLength(key, collapsed);
}

function sanitizeEmail(value) {
  if (typeof value !== 'string') return '';
  return limitLength('email', value.trim().toLowerCase());
}

function normalizeConsent(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;

  return ['on', 'true', '1', 'yes'].includes(value.trim().toLowerCase());
}

function normalizeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function limitLength(key, value) {
  if (typeof value !== 'string') return value;
  const max = MAX_FIELD_LENGTHS[key];
  return max ? value.slice(0, max) : value;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function logEvent(event, details = {}) {
  console.log('[dec-checkup]', JSON.stringify({ event, ...details }));
}

function resolveClientMessage(rawScore) {
  const score = Number(rawScore || 0);

  if (score >= 6) {
    return 'Richiesta inviata. Il team DEC ti ricontatterà con priorità per proporti il percorso più adatto al tuo profilo.';
  }

  if (score >= 2) {
    return 'Richiesta inviata. Il team DEC userà il tuo check-up per capire insieme a te il percorso più sensato da attivare.';
  }

  return 'Richiesta inviata. Il team DEC ti ricontatterà per aiutarti a capire opzioni, tempi e livello di supporto più adatto.';
}
