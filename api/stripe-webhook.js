// Stripe Webhook → ActiveCampaign
// Trigger: checkout.session.completed per workshop €37

const AC_API_KEY = process.env.ACTIVECAMPAIGN_API_KEY;
const AC_API_URL = 'https://riccardoromano.api-us1.com/api/3';
const WORKSHOP_PRODUCT_ID = 'prod_USjzUEhQTIuPyJ';
const LIST_ID = 14; // ID lista RR-Cliente

export default async function handler(req, res) {
  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const event = req.body;

    // Verifica tipo evento
    if (event.type !== 'checkout.session.completed') {
      return res.status(200).json({ received: true, ignored: 'Event type not handled' });
    }

    const session = event.data.object;
    const customerEmail = session.customer_details?.email;
    const customerName = session.customer_details?.name || '';
    
    // Determina se live o test mode
    const isLiveMode = session.livemode === true;
    
    // Verifica product workshop €37 (solo in live mode)
    if (isLiveMode) {
      const lineItems = session.line_items?.data || [];
      const hasWorkshop = lineItems.some(item => 
        item.price?.product === WORKSHOP_PRODUCT_ID
      );

      if (!hasWorkshop) {
        return res.status(200).json({ received: true, ignored: 'Not workshop product' });
      }
    }

    if (!customerEmail) {
      return res.status(400).json({ error: 'No customer email' });
    }

    // Tag unificato
    const tags = ['RR-Acquisto-OC-Workshop'];

    // Prepara dati contatto
    const contactData = {
      email: customerEmail,
      firstName: customerName
    };

    // Aggiungi contatto a ActiveCampaign
    const acResponse = await fetch(`${AC_API_URL}/contacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Token': AC_API_KEY
      },
      body: JSON.stringify({
        contact: contactData
      })
    });

    if (!acResponse.ok) {
      const error = await acResponse.text();
      console.error('ActiveCampaign error:', error);
      return res.status(500).json({ error: 'Failed to create contact' });
    }

    const contactResult = await acResponse.json();
    const contactId = contactResult.contact?.id;

    // Aggiungi tag al contatto
    if (contactId) {
      for (const tag of tags) {
        await fetch(`${AC_API_URL}/contactTags`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Api-Token': AC_API_KEY
          },
          body: JSON.stringify({
            contactTag: {
              contact: contactId,
              tag: tag
            }
          })
        });
      }
    }

    // Aggiungi contatto alla lista RR-Cliente
    if (contactId) {
      await fetch(`${AC_API_URL}/contactLists`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Token': AC_API_KEY
        },
        body: JSON.stringify({
          contactList: {
            list: LIST_ID,
            contact: contactId,
            status: 1 // Active
          }
        })
      });
    }

    return res.status(200).json({
      success: true,
      mode: isLiveMode ? 'live' : 'test',
      contact: customerEmail,
      name: customerName,
      ac_contact_id: contactId
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
