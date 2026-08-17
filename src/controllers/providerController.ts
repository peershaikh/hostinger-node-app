import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { providerConfigService } from '../services/providerConfigService';
import { authService } from '../services/authService';
import { railProviderRegistry, ProviderCapabilities } from '../services/railProviderRegistry';
import { railProviderResolver } from '../services/railProviderResolver';

// Graceful database outage in-memory fallback store
export let fallbackProviders: any[] = [
  {
    id: '01d4df69-d510-4c38-9d95-d2d8e0f9cad4',
    provider_name: 'IRCTC',
    priority: 1,
    enabled: true,
    is_deleted: false,
    health_status: 'ACTIVE',
    consecutive_failures: 0,
    response_latency: 120,
    api_key: 'mock_encrypted_irctc_key',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    id: '03d4df69-d510-4c38-9d95-d2d8e0f9cad4',
    provider_name: 'RAILRADAR',
    priority: 2,
    enabled: true,
    is_deleted: false,
    health_status: 'ACTIVE',
    consecutive_failures: 0,
    response_latency: 75,
    api_key: 'mock_encrypted_railradar_key',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
];

const enrichProvider = (provider: any) => {
  const nameUpper = (provider.provider_name || '').toUpperCase().trim();
  const reg = railProviderRegistry.getProvider(nameUpper);
  const capabilities: ProviderCapabilities = reg ? reg.capabilities : {
    search: false,
    availability: false,
    liveTracking: false,
    pnr: false,
    schedule: false
  };

  const hasCredentials = Boolean(
    (provider.api_key && provider.api_key.length > 5) ||
    (nameUpper === 'IRCTC' && Boolean(process.env.IRCTC_CONNECT_API_KEY || process.env.IRCTC_API_KEY)) ||
    (nameUpper === 'RAILRADAR' && Boolean(process.env.RAILRADAR_API_KEY)) ||
    (nameUpper === 'CONFIRMTKT' && Boolean(process.env.CONFIRMTKT_API_KEY || process.env.RAPIDAPI_KEY)) ||
    (nameUpper === 'RAILYATRI' && Boolean(process.env.RAILYATRI_API_KEY || process.env.RAPIDAPI_KEY)) ||
    nameUpper === 'DATABASE'
  );

  return {
    ...provider,
    api_key: provider.id ? '********' + provider.id.substring(0, 4) : '********',
    credentials_configured: hasCredentials,
    capabilities,
    display_name: reg ? reg.displayName : provider.provider_name
  };
};

const computeFeatureMatrix = async () => {
  const features: Array<keyof ProviderCapabilities> = ['search', 'availability', 'liveTracking', 'pnr', 'schedule'];
  const matrix: Record<string, { primary: string; fallbacks: string[]; supported_providers: string[] }> = {};

  for (const f of features) {
    try {
      const chain = await railProviderResolver.resolveProviderChain(f);
      const supported = railProviderRegistry.getProvidersByCapability(f).map(p => p.providerId);
      matrix[f] = {
        primary: chain.length > 0 ? chain[0].providerId : 'NONE',
        fallbacks: chain.slice(1).map(p => p.providerId),
        supported_providers: supported
      };
    } catch {
      matrix[f] = { primary: 'NONE', fallbacks: [], supported_providers: [] };
    }
  }

  return matrix;
};

export const getProviders = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('api_providers')
      .select('*')
      .eq('is_deleted', false)
      .order('priority', { ascending: true });

    if (error) {
      winstonLogger.warn(`[Admin] Database api_providers query failed: ${error.message}. Redirecting to in-memory fallback.`);
      throw error;
    }

    if (!data || data.length === 0) {
      winstonLogger.info(`[Admin] Database api_providers table is empty. Redirecting to in-memory fallback.`);
      throw new Error('Database api_providers table is empty');
    }

    const enriched = data.map(enrichProvider);
    const feature_matrix = await computeFeatureMatrix();

    res.status(200).json({ success: true, providers: enriched, feature_matrix });
  } catch (error: any) {
    // Graceful in-memory fallback
    const activeProviders = fallbackProviders
      .filter((p) => !p.is_deleted)
      .sort((a, b) => a.priority - b.priority)
      .map(enrichProvider);

    const feature_matrix = await computeFeatureMatrix();

    res.status(200).json({ success: true, providers: activeProviders, feature_matrix, fallback: true });
  }
};

export const createProvider = async (req: Request, res: Response) => {
  try {
    const { provider_name, api_key, priority, enabled } = req.body;
    const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
    const adminUser = await authService.getUserById(adminId);
    const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';

    const maskedDetails = {
      provider_name,
      priority,
      enabled,
      api_key: '[REDACTED]'
    };

    const encryptedKey = api_key ? providerConfigService.encryptKey(api_key) : '';

    try {
      const { data: providerId, error } = await supabase.rpc('admin_create_provider_rpc', {
        p_admin_id: adminId,
        p_admin_email: adminEmail,
        p_provider_name: provider_name,
        p_api_key: encryptedKey,
        p_priority: priority || 99,
        p_enabled: enabled ?? true,
        p_ip_address: req.ip || req.headers['x-forwarded-for'] as string || null,
        p_user_agent: req.headers['user-agent'] || null,
        p_details: maskedDetails
      });

      if (error) throw error;

      providerConfigService.flushCache(provider_name);
      const feature_matrix = await computeFeatureMatrix();

      res.status(201).json({
        success: true,
        provider: { id: providerId, provider_name, priority, enabled },
        feature_matrix
      });
    } catch (dbError: any) {
      winstonLogger.warn(`[Admin] Database create provider RPC failed: ${dbError.message}. Using in-memory fallback.`);

      const newProvider = {
        id: `fb-${Date.now()}`,
        provider_name,
        priority: priority || 99,
        enabled: enabled ?? true,
        is_deleted: false,
        health_status: 'ACTIVE',
        consecutive_failures: 0,
        response_latency: 0,
        api_key: encryptedKey,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      fallbackProviders.push(newProvider);
      providerConfigService.flushCache(provider_name);
      const feature_matrix = await computeFeatureMatrix();

      res.status(201).json({
        success: true,
        provider: { id: newProvider.id, provider_name, priority, enabled },
        feature_matrix,
        fallback: true
      });
    }
  } catch (error: any) {
    winstonLogger.error(`[ADMIN_EXCEPTION] CreateProvider transaction failed. Error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
  }
};

export const updateProvider = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { priority, enabled, api_key, health_status } = req.body;
    const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
    const adminUser = await authService.getUserById(adminId);
    const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';

    const encryptedKey = api_key && !api_key.startsWith('********')
      ? providerConfigService.encryptKey(api_key)
      : null;

    try {
      const { data: existing, error: fetchErr } = await supabase
        .from('api_providers')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchErr || !existing) throw new Error('Provider not found');

      const maskedDetails = {
        provider_id: id,
        priority,
        enabled,
        health_status,
        api_key: api_key ? '[REDACTED]' : undefined,
        previous: { priority: existing.priority, enabled: existing.enabled, health_status: existing.health_status }
      };

      const rpcPayload = {
        p_admin_id: adminId,
        p_admin_email: adminEmail,
        p_provider_id: id,
        p_api_key: encryptedKey ?? null,
        p_priority: priority ?? null,
        p_enabled: enabled ?? null,
        p_ip_address: req.ip || req.headers['x-forwarded-for'] as string || null,
        p_user_agent: req.headers['user-agent'] || null,
        p_details: maskedDetails
      };

      const { data: rpcData, error } = await supabase.rpc('admin_update_provider_rpc', rpcPayload);
      if (error) throw error;

      providerConfigService.flushCache(existing.provider_name);
      const feature_matrix = await computeFeatureMatrix();

      res.status(200).json({
        success: true,
        provider: { id, priority, enabled, health_status },
        feature_matrix
      });
    } catch (dbError: any) {
      winstonLogger.warn(`[Admin] DB update provider failed: ${dbError.message}. Using in-memory fallback.`);
      
      const existing = fallbackProviders.find(p => p.id === id);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Provider not found' });
      }

      if (priority !== undefined) existing.priority = priority;
      if (enabled !== undefined) existing.enabled = enabled;
      if (health_status !== undefined) existing.health_status = health_status;
      if (encryptedKey) existing.api_key = encryptedKey;
      existing.updated_at = new Date().toISOString();

      providerConfigService.flushCache(existing.provider_name);
      const feature_matrix = await computeFeatureMatrix();

      res.status(200).json({
        success: true,
        provider: { id, priority, enabled, health_status },
        feature_matrix,
        fallback: true
      });
    }
  } catch (error: any) {
    winstonLogger.error(`[ADMIN_EXCEPTION] UpdateProvider transaction failed. Error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
  }
};

export const batchUpdateProviders = async (req: Request, res: Response) => {
  try {
    const { updates } = req.body; // Array of { id, priority, enabled }
    const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
    const adminUser = await authService.getUserById(adminId);
    const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ success: false, error: 'Updates array is required' });
    }

    for (const item of updates) {
      if (!item.id) continue;
      try {
        await supabase.from('api_providers').update({
          priority: item.priority,
          enabled: item.enabled,
          updated_at: new Date().toISOString()
        }).eq('id', item.id);
      } catch (err: any) {
        winstonLogger.warn(`[Admin] Batch update failed for item ${item.id}: ${err.message}`);
      }
    }

    providerConfigService.flushCache();
    const feature_matrix = await computeFeatureMatrix();

    // Log batch audit event
    try {
      await supabase.from('admin_security_audit_logs').insert({
        admin_id: adminId,
        admin_email: adminEmail,
        action: 'BATCH_UPDATE_PROVIDERS',
        ip_address: req.ip || null,
        user_agent: req.headers['user-agent'] || null,
        details: { updates_count: updates.length, updates }
      });
    } catch {}

    res.status(200).json({ success: true, message: 'Batch configuration saved', feature_matrix });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const testProvider = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { provider_name, feature } = req.body;

    let targetName = provider_name;
    if (!targetName && id) {
      try {
        const { data } = await supabase.from('api_providers').select('provider_name').eq('id', id).maybeSingle();
        targetName = data?.provider_name;
      } catch {}
      if (!targetName) {
        const fb = fallbackProviders.find(p => p.id === id);
        if (fb) targetName = fb.provider_name;
      }
    }

    if (!targetName) {
      return res.status(400).json({ success: false, error: 'Provider name or ID is required' });
    }

    const nameUpper = targetName.toUpperCase().trim();
    const provider = railProviderRegistry.getProvider(nameUpper);
    if (!provider) {
      return res.status(404).json({ success: false, error: `Provider '${targetName}' not found in registry` });
    }

    // If specific feature requested, validate capability
    if (feature) {
      const featKey = feature as keyof ProviderCapabilities;
      if (!provider.capabilities[featKey]) {
        return res.status(400).json({
          success: false,
          reason: 'UNSUPPORTED_CAPABILITY',
          message: `Provider '${nameUpper}' does not support '${feature}'`
        });
      }
    }

    const start = Date.now();
    let healthResult: any = null;
    if (typeof provider.healthCheck === 'function') {
      healthResult = await provider.healthCheck();
    } else {
      healthResult = {
        status: 'UNSUPPORTED_PROBE',
        latencyMs: Date.now() - start,
        message: 'No health check probe implemented for this provider',
        timestamp: new Date().toISOString()
      };
    }

    const probeStatus = healthResult.status || 'UNAVAILABLE';
    const isSuccess = probeStatus === 'HEALTHY' || probeStatus === 'DEGRADED';

    return res.status(200).json({
      success: isSuccess,
      provider: nameUpper,
      feature: feature || 'HEALTH_CHECK',
      status: probeStatus,
      health: healthResult,
      message: healthResult.message || `Provider ${nameUpper} probe returned ${probeStatus}`
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const getProviderHistory = async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('admin_security_audit_logs')
      .select('*')
      .ilike('action', '%PROVIDER%')
      .order('created_at', { ascending: false })
      .limit(15);

    if (error) throw error;
    return res.status(200).json({ success: true, history: data || [] });
  } catch {
    return res.status(200).json({ success: true, history: [] });
  }
};

export const rollbackProviderConfig = async (req: Request, res: Response) => {
  try {
    const { provider_id, previous_priority, previous_enabled } = req.body;
    const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
    const adminUser = await authService.getUserById(adminId);
    const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';

    if (!provider_id) {
      return res.status(400).json({ success: false, error: 'provider_id is required for rollback' });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('api_providers')
      .select('*')
      .eq('id', provider_id)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ success: false, error: 'Provider not found' });
    }

    const rpcPayload = {
      p_admin_id: adminId,
      p_admin_email: adminEmail,
      p_provider_id: provider_id,
      p_api_key: null,
      p_priority: typeof previous_priority === 'number' ? previous_priority : existing.priority,
      p_enabled: typeof previous_enabled === 'boolean' ? previous_enabled : existing.enabled,
      p_ip_address: req.ip || req.headers['x-forwarded-for'] as string || null,
      p_user_agent: req.headers['user-agent'] || null,
      p_details: {
        action: 'ROLLBACK_PROVIDER_CONFIG',
        provider_id,
        restored_priority: previous_priority,
        restored_enabled: previous_enabled
      }
    };

    try {
      const { error: rpcError } = await supabase.rpc('admin_update_provider_rpc', rpcPayload);
      if (rpcError) throw rpcError;
    } catch (rpcErr: any) {
      // Fallback direct table update if RPC constraint fails (e.g. test env)
      await supabase.from('api_providers').update({
        priority: rpcPayload.p_priority,
        enabled: rpcPayload.p_enabled,
        updated_at: new Date().toISOString()
      }).eq('id', provider_id);
    }

    providerConfigService.flushCache(existing.provider_name);
    const feature_matrix = await computeFeatureMatrix();

    return res.status(200).json({
      success: true,
      message: 'Configuration successfully restored',
      feature_matrix
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const deleteProvider = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
    const adminUser = await authService.getUserById(adminId);
    const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';

    try {
      const { data: existing, error: fetchErr } = await supabase
        .from('api_providers')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchErr || !existing) throw new Error('Provider not found');

      const maskedDetails = {
        provider_id: id,
        previous: { enabled: existing.enabled }
      };

      const { error } = await supabase.rpc('admin_delete_provider_rpc', {
        p_admin_id: adminId,
        p_admin_email: adminEmail,
        p_provider_id: id,
        p_ip_address: req.ip || req.headers['x-forwarded-for'] as string || null,
        p_user_agent: req.headers['user-agent'] || null,
        p_details: maskedDetails
      });

      if (error) throw error;

      providerConfigService.flushCache(existing.provider_name);
      const feature_matrix = await computeFeatureMatrix();

      res.status(200).json({ success: true, feature_matrix });
    } catch (dbError: any) {
      winstonLogger.warn(`[Admin] DB delete provider failed: ${dbError.message}. Using in-memory fallback.`);
      
      const existing = fallbackProviders.find(p => p.id === id);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Provider not found' });
      }

      existing.is_deleted = true;
      existing.updated_at = new Date().toISOString();
      providerConfigService.flushCache(existing.provider_name);
      const feature_matrix = await computeFeatureMatrix();

      res.status(200).json({ success: true, feature_matrix, fallback: true });
    }
  } catch (error: any) {
    winstonLogger.error(`[ADMIN_EXCEPTION] DeleteProvider transaction failed. Error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
  }
};
