function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function getStripeSecretKeyForSession(session = {}) {
  const useLive = !!session.livemode;
  return useLive
    ? (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_LIVE_SECRET_KEY || null)
    : (process.env.STRIPE_TEST_SECRET_KEY || null);
}

async function stripeRequest(session, path, options = {}, attempt = 1) {
  const secretKey = getStripeSecretKeyForSession(session);
  if (!secretKey) throw new Error(`Stripe secret key not configured for ${session?.livemode ? 'live' : 'test'} mode`);

  const body = options.body;
  const response = await fetch(`https://api.stripe.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const detail = data?.error?.message || text;
    if (attempt < 5 && (response.status === 429 || response.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      return stripeRequest(session, path, options, attempt + 1);
    }
    throw new Error(`Stripe ${path} failed: ${response.status} ${detail}`);
  }
  return data;
}

async function acRequest(path, options = {}, attempt = 1) {
  const baseUrl = (process.env.ACTIVECAMPAIGN_API_URL || 'https://riccardoromano.api-us1.com/api/3').replace(/\/$/, '');
  const apiKey = process.env.ACTIVECAMPAIGN_API_KEY;
  if (!apiKey) throw new Error('ActiveCampaign API key not configured');

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Api-Token': apiKey,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const detail = data?.message || data?.errors?.[0]?.title || text;
      if (attempt < 5 && (response.status === 429 || response.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        return acRequest(path, options, attempt + 1);
      }
      throw new Error(`AC ${path} failed: ${response.status} ${detail}`);
    }
    return data;
  } catch (error) {
    if (attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      return acRequest(path, options, attempt + 1);
    }
    throw error;
  }
}

async function getAllFields() {
  const limit = 100;
  let offset = 0;
  const all = [];
  while (true) {
    const data = await acRequest(`/fields?limit=${limit}&offset=${offset}`);
    const chunk = data.fields || [];
    all.push(...chunk);
    if (chunk.length < limit) break;
    offset += limit;
  }
  return all;
}

async function getFieldMap() {
  const fields = await getAllFields();
  const wanted = ['Address', 'Country', 'Città', 'Provincia', 'CAP', 'Data Acquisto', 'Ultimo Prodotto Acquistato', 'Valore Ultimo Prodotto Acquistato', 'LTV'];
  const map = {};
  for (const field of fields) {
    if (wanted.includes(field.title)) map[field.title] = field.id;
  }
  return map;
}

async function getTagIdByName(tagName) {
  const data = await acRequest(`/tags?search=${encodeURIComponent(tagName)}`);
  const tag = (data.tags || []).find((item) => item.tag === tagName);
  return tag ? String(tag.id) : null;
}

async function getFirstExistingTagId(tagNames) {
  for (const tagName of tagNames) {
    const tagId = await getTagIdByName(tagName);
    if (tagId) return { tagId, tagName };
  }
  return null;
}

async function getOrCreateContact(customer) {
  const existing = await acRequest(`/contacts?email=${encodeURIComponent(customer.email)}`);
  const found = existing.contacts && existing.contacts[0];
  const payload = {
    contact: {
      email: customer.email,
      firstName: customer.firstName || '',
      lastName: customer.lastName || '',
      phone: String(customer.phone || '').trim(),
    },
  };

  if (found) {
    const updated = await acRequest(`/contacts/${found.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    return updated.contact || found;
  }

  const created = await acRequest('/contacts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return created.contact;
}

async function getExistingFieldValues(contactId) {
  const data = await acRequest(`/contacts/${contactId}/fieldValues`);
  const map = {};
  for (const fv of data.fieldValues || []) {
    map[String(fv.field)] = fv;
  }
  return map;
}

async function upsertFieldValue(contactId, fieldId, value, existingMap) {
  if (!fieldId) return;
  const normalized = String(value ?? '');
  const existing = existingMap[String(fieldId)];
  if (existing) {
    await acRequest(`/fieldValues/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify({ fieldValue: { contact: String(contactId), field: String(fieldId), value: normalized } }),
    });
    return;
  }
  const created = await acRequest('/fieldValues', {
    method: 'POST',
    body: JSON.stringify({ fieldValue: { contact: String(contactId), field: String(fieldId), value: normalized } }),
  });
  if (created.fieldValue?.id) existingMap[String(fieldId)] = created.fieldValue;
}

function formatAcDateTimeCanary(unixSeconds) {
  const date = unixSeconds ? new Date(unixSeconds * 1000) : new Date();
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Atlantic/Canary',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

async function applyFirstExistingTag(contactId, tagNames) {
  const match = await getFirstExistingTagId(tagNames);
  if (!match) throw new Error(`ActiveCampaign tag not found: ${tagNames.join(' | ')}`);
  try {
    await acRequest('/contactTags', {
      method: 'POST',
      body: JSON.stringify({ contactTag: { contact: String(contactId), tag: String(match.tagId) } }),
    });
    return match;
  } catch (error) {
    if (!String(error.message || '').toLowerCase().includes('duplicate')) throw error;
    return match;
  }
}

async function getSessionLineItems(session) {
  if (!session?.id) return [];
  const data = await stripeRequest(session, `/v1/checkout/sessions/${session.id}/line_items?limit=10`);
  return data.data || [];
}

async function resolveOcaeContext(session) {
  const metadata = session.metadata || {};
  if (metadata.product_key === 'ocae') {
    return {
      isOcae: true,
      productKey: 'ocae',
      productName: metadata.product_name || 'OpenClaw Activation Experience',
      purchaseValue: String(
        metadata.total_amount
          || metadata.base_price
          || (typeof session.amount_total === 'number' ? (session.amount_total / 100) : '')
      ),
    };
  }

  const lineItems = await getSessionLineItems(session);
  const ocaeItem = lineItems.find((item) => {
    const description = String(item?.description || '').toLowerCase();
    const priceMeta = item?.price?.metadata || {};
    const priceNickname = String(item?.price?.nickname || '').toLowerCase();
    return priceMeta.product_slug === 'ocae'
      || priceMeta.product_key === 'ocae'
      || description.includes('openclaw activation experience')
      || priceNickname.includes('ocae');
  });

  if (!ocaeItem) {
    return {
      isOcae: false,
      productKey: metadata.product_key || '',
      productName: metadata.product_name || '',
      purchaseValue: '',
    };
  }

  return {
    isOcae: true,
    productKey: 'ocae',
    productName: metadata.product_name || ocaeItem.description || 'OpenClaw Activation Experience',
    purchaseValue: String(
      metadata.total_amount
        || metadata.base_price
        || (typeof ocaeItem.amount_total === 'number' ? (ocaeItem.amount_total / 100) : '')
        || (typeof session.amount_total === 'number' ? (session.amount_total / 100) : '')
    ),
  };
}

async function syncOcaePurchase(session, ocaeContext = null) {
  const metadata = session.metadata || {};
  const customerDetails = session.customer_details || {};
  const customerAddress = customerDetails.address || {};
  const productName = ocaeContext?.productName || metadata.product_name || 'OpenClaw Activation Experience';
  const purchaseValue = String(
    ocaeContext?.purchaseValue
      || metadata.total_amount
      || metadata.base_price
      || (typeof session.amount_total === 'number' ? (session.amount_total / 100) : '')
  );
  const customer = {
    email: customerDetails.email || session.customer_email || '',
    firstName: customerDetails.name?.split(' ')?.slice(0, -1).join(' ') || metadata.first_name || '',
    lastName: customerDetails.name?.split(' ')?.slice(-1).join(' ') || metadata.last_name || '',
    phone: customerDetails.phone || metadata.phone || '',
    country: metadata.country || customerAddress.country || '',
    address: metadata.address || [customerAddress.line1, customerAddress.line2].filter(Boolean).join(' ').trim(),
    city: metadata.city || customerAddress.city || '',
    state: metadata.state || customerAddress.state || '',
    postalCode: metadata.postal_code || customerAddress.postal_code || '',
  };

  if (!customer.email) throw new Error('No customer email on checkout session');

  const contact = await getOrCreateContact(customer);
  const fieldMap = await getFieldMap();
  const existingValues = await getExistingFieldValues(contact.id);
  await Promise.all([
    upsertFieldValue(contact.id, fieldMap['Address'], customer.address, existingValues),
    upsertFieldValue(contact.id, fieldMap['Country'], customer.country, existingValues),
    upsertFieldValue(contact.id, fieldMap['Città'], customer.city, existingValues),
    upsertFieldValue(contact.id, fieldMap['Provincia'], customer.state, existingValues),
    upsertFieldValue(contact.id, fieldMap['CAP'], customer.postalCode, existingValues),
    upsertFieldValue(contact.id, fieldMap['Data Acquisto'], formatAcDateTimeCanary(session.created), existingValues),
    upsertFieldValue(contact.id, fieldMap['Ultimo Prodotto Acquistato'], productName, existingValues),
    upsertFieldValue(contact.id, fieldMap['Valore Ultimo Prodotto Acquistato'], purchaseValue, existingValues),
  ]);
  const tagMatch = await applyFirstExistingTag(contact.id, ['RR-Acquisto-OC-OCAE']);
  return { contactId: contact.id, tagName: tagMatch.tagName, productName, purchaseValue };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed' });
  }

  try {
    const event = req.body || {};
    if (event.type !== 'checkout.session.completed') {
      return json(res, 200, { received: true, ignored: 'Event type not handled' });
    }

    const session = event.data?.object || {};
    const ocaeContext = await resolveOcaeContext(session);

    if (!ocaeContext.isOcae) {
      return json(res, 200, { received: true, ignored: 'Non-OCAE checkout' });
    }

    const synced = await syncOcaePurchase(session, ocaeContext);
    return json(res, 200, {
      success: true,
      product: 'ocae',
      contactId: synced.contactId,
      tagApplied: synced.tagName,
      productName: synced.productName,
      purchaseValue: synced.purchaseValue,
      livemode: !!session.livemode,
    });
  } catch (error) {
    return json(res, 500, { error: 'Webhook processing failed', detail: error.message || String(error) });
  }
};
