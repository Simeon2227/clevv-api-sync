serve(async (req) => {
  const startTime = Date.now();

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }

  try {
    const authHeader = req.headers.get('Authorization');
    const userAgent = req.headers.get('User-Agent') || '';
    const clientIP = req.headers.get('x-forwarded-for') ||
                     req.headers.get('x-real-ip') ||
                     'unknown';

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      await logRequest(null, null, req, 401, 'Missing or invalid Authorization header', startTime, clientIP, userAgent);
      return new Response(
        JSON.stringify({ error: 'Missing or invalid Authorization header' }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    const apiKey = authHeader.substring(7);

    const { data: keyData, error: keyError } = await supabase
      .from('vendor_api_keys')
      .select('id, vendor_id, is_active')
      .eq('api_key', apiKey)
      .eq('is_active', true)
      .maybeSingle();

    if (keyError || !keyData) {
      await logRequest(null, null, req, 401, 'Invalid API key', startTime, clientIP, userAgent);
      return new Response(
        JSON.stringify({ error: 'Invalid API key' }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    await supabase
      .from('vendor_api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', keyData.id);

    // 🔁 Handle Shopify Webhook format OR normal format
    const rawBody = await req.json();
    const requestBody: SyncRequest =
      'title' in rawBody && 'variants' in rawBody
        ? {
            products: [
              {
                external_id: rawBody.id.toString(),
                title: rawBody.title,
                description: rawBody.body_html || '',
                price: parseFloat(rawBody.variants?.[0]?.price || '0'),
                category: rawBody.product_type || 'Uncategorized',
                inventory_count: rawBody.variants?.[0]?.inventory_quantity || 0,
                status: rawBody.status || 'active',
                images: rawBody.images?.map((img: any) => img.src) || [],
                metadata: {
                  vendor: rawBody.vendor || 'Unknown',
                  shopify_handle: rawBody.handle
                }
              }
            ]
          }
        : rawBody;

    // 🔐 Safety Check
    if (!requestBody.products || !Array.isArray(requestBody.products)) {
      await logRequest(keyData.vendor_id, keyData.id, req, 400, 'Invalid request body: products array required', startTime, clientIP, userAgent, requestBody);
      return new Response(
        JSON.stringify({ error: 'Invalid request body: products array required' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    if (requestBody.products.length === 0) {
      await logRequest(keyData.vendor_id, keyData.id, req, 400, 'Empty products array', startTime, clientIP, userAgent, requestBody);
      return new Response(
        JSON.stringify({ error: 'Empty products array' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    // 🛠 Product processing remains unchanged (use your original logic)
    const processedProducts = [];
    const errors = [];

    for (const product of requestBody.products) {
      try {
        if (!product.external_id || !product.title) {
          errors.push(`Product missing required fields: external_id and title are required`);
          continue;
        }

        const productData = {
          vendor_id: keyData.vendor_id,
          external_id: product.external_id,
          title: product.title,
          description: product.description || null,
          price: product.price || null,
          category: product.category || null,
          inventory_count: product.inventory_count || 0,
          status: product.status || 'active',
          images: product.images || [],
          metadata: product.metadata || {},
          synced_at: new Date().toISOString()
        };

        const { data: upsertedProduct, error: upsertError } = await supabase
          .from('vendor_listings')
          .upsert(productData, {
            onConflict: 'vendor_id,external_id',
            ignoreDuplicates: false
          })
          .select()
          .single();

        if (upsertError) {
          errors.push(`Failed to sync product ${product.external_id}: ${upsertError.message}`);
          continue;
        }

        processedProducts.push(upsertedProduct);
      } catch (error) {
        errors.push(`Error processing product ${product.external_id}: ${error.message}`);
      }
    }

    const responseMessage = `Successfully synced ${processedProducts.length} products${errors.length > 0 ? ` with ${errors.length} errors` : ''}`;

    await logRequest(keyData.vendor_id, keyData.id, req, 200, responseMessage, startTime, clientIP, userAgent, requestBody);

    const response = {
      success: true,
      message: 'Products received and indexed',
      processed_count: processedProducts.length,
      error_count: errors.length,
      ...(errors.length > 0 && { errors })
    };

    return new Response(
      JSON.stringify(response),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error('Catalog sync error:', error);
    await logRequest(null, null, req, 500, `Internal server error: ${error.message}`, startTime, 'unknown', '');
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Internal server error',
        message: 'An unexpected error occurred while processing your request'
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});