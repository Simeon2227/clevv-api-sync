import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const handler = async (event: any) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  const auth = event.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();

  const { data: apiKeyRow, error: keyError } = await supabase
    .from('vendor_api_keys')
    .select('id, vendor_id, is_active')
    .eq('api_key', token)
    .eq('is_active', true)
    .maybeSingle();

  if (keyError || !apiKeyRow) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid API key' })
    };
  }

  let body = JSON.parse(event.body || '{}');

  // Shopify product object transform fallback
  if (body && body.title && body.variants) {
    body = {
      products: [
        {
          external_id: body.id.toString(),
          title: body.title,
          description: body.body_html,
          price: parseFloat(body.variants?.[0]?.price || '0'),
          category: body.product_type || 'Uncategorized',
          inventory_count: body.variants?.[0]?.inventory_quantity || 0,
          status: body.status || 'active',
          images: body.images?.map((img: any) => img.src) || [],
          metadata: {
            vendor: body.vendor,
            handle: body.handle
          }
        }
      ]
    };
  }

  const inserted: any[] = [];

  for (const product of body.products || []) {
    const { error } = await supabase.from('vendor_listings').upsert({
      vendor_id: apiKeyRow.vendor_id,
      external_id: product.external_id,
      title: product.title,
      description: product.description,
      price: product.price,
      status: product.status,
      metadata: product.metadata,
      synced_at: new Date().toISOString()
    });

    if (!error) inserted.push(product.title);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      synced: inserted.length
    })
  };
};
