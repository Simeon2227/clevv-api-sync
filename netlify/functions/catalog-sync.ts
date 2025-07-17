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
  let resolvedVendorId = null;

  // Check API key first
  if (token && token !== '') {
    const { data: apiKeyRow, error } = await supabase
      .from('vendor_api_keys')
      .select('vendor_id')
      .eq('api_key', token)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !apiKeyRow) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Invalid API key' })
      };
    }

    resolvedVendorId = apiKeyRow.vendor_id;
  } else {
    // No token – try Shopify vendor fallback
    const rawBody = JSON.parse(event.body || '{}');
    const storeName = rawBody?.vendor;

    if (!storeName) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'No vendor name provided in webhook' })
      };
    }

    const { data: mappedStore, error } = await supabase
      .from('shopify_store_mappings')
      .select('vendor_id')
      .eq('store_name', storeName)
      .maybeSingle();

    if (error || !mappedStore) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'No vendor matched for this store' })
      };
    }

    resolvedVendorId = mappedStore.vendor_id;
  }

  // Parse into products array (handles Shopify raw too)
  let payload = JSON.parse(event.body || '{}');
  const products = payload.products || (payload.title ? [{
    external_id: payload.id.toString(),
    title: payload.title,
    description: payload.body_html || '',
    price: parseFloat(payload.variants?.[0]?.price || '0'),
    category: payload.product_type || 'Uncategorized',
    inventory_count: payload.variants?.[0]?.inventory_quantity || 0,
    status: 'approved',
    images: payload.images?.map((img: any) => img.src) || [],
    metadata: {
      vendor: payload.vendor || '',
      handle: payload.handle || '',
      shopify_id: payload.id
    }
  }] : []);

  const syncedTitles: string[] = [];

  for (const product of products) {
    const now = new Date().toISOString();

    const insertData = {
      vendor_id: resolvedVendorId,
      external_id: product.external_id,
      title: product.title,
      description: product.description || '',
      price: product.price || 0,
      category: product.category || 'Real Estate',
      inventory_count: product.inventory_count || 1,
      status: 'approved',
      images: product.images || [],
      metadata: product.metadata || {},
      source: 'shopify-sync',
      synced_at: now,
      visible_on_dashboard: true
    };

    await supabase.from('vendor_listings').upsert(insertData, {
      onConflict: 'vendor_id,external_id'
    });

    syncedTitles.push(product.title);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, synced: syncedTitles.length, titles: syncedTitles })
  };
};
