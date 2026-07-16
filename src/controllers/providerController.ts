import { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { winstonLogger } from '../middleware/logger';
import { providerConfigService } from '../services/providerConfigService';
import { authService } from '../services/authService';

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

    // Mask the API keys before sending to frontend
    const maskedData = data.map((provider: any) => ({
      ...provider,
      api_key: '********' + provider.id.substring(0, 4)
    }));

    res.status(200).json({ success: true, providers: maskedData });
  } catch (error: any) {
    // Graceful in-memory fallback
    const activeProviders = fallbackProviders
      .filter((p) => !p.is_deleted)
      .sort((a, b) => a.priority - b.priority)
      .map((provider) => ({
        ...provider,
        api_key: '********' + provider.id.substring(0, 4)
      }));

    res.status(200).json({ success: true, providers: activeProviders, fallback: true });
  }
};


export const createProvider = async (req: Request, res: Response) => {
  try {
    const { provider_name, api_key, priority, enabled } = req.body;
    const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
    const adminUser = await authService.getUserById(adminId);
    const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';

    // 1. Dynamic Details Payload with Credential Masking
    const maskedDetails = {
      provider_name,
      priority,
      enabled,
      api_key: '[REDACTED]'
    };

    // 2. Encrypt Credential prior to DB storage
    const encryptedKey = providerConfigService.encryptKey(api_key);

    try {
      // 3. Execute Database-level Transactional RPC
      const { data: providerId, error } = await supabase.rpc('admin_create_provider_rpc', {
        p_admin_id: adminId,
        p_admin_email: adminEmail,
        p_provider_name: provider_name,
        p_api_key: encryptedKey,
        p_priority: priority,
        p_enabled: enabled ?? true,
        p_ip_address: req.ip || req.headers['x-forwarded-for'] as string || null,
        p_user_agent: req.headers['user-agent'] || null,
        p_details: maskedDetails
      });

      if (error) throw error;

      // 4. DB Succeeded: Flush cache
      providerConfigService.flushCache(provider_name);

      res.status(201).json({ success: true, provider: { id: providerId, provider_name, priority, enabled } });
    } catch (dbError: any) {
      winstonLogger.warn(`[Admin] DB create provider RPC failed: ${dbError.message}. Using in-memory fallback.`);
      
      const newProvider = {
        id: `provider-${Date.now()}`,
        provider_name,
        api_key: encryptedKey,
        priority: priority ?? 1,
        enabled: enabled ?? true,
        is_deleted: false,
        health_status: 'ACTIVE',
        consecutive_failures: 0,
        response_latency: 100,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      fallbackProviders.push(newProvider);
      providerConfigService.flushCache(provider_name);
      
      winstonLogger.info(`[api_provider_toggled] Telemetry logged. Provider toggled: ${provider_name}`);

      res.status(201).json({ success: true, provider: { id: newProvider.id, provider_name, priority, enabled }, fallback: true });
    }
  } catch (error: any) {
    winstonLogger.error(`[ADMIN_EXCEPTION] CreateProvider transaction failed. Error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
  }
};

export const updateProvider = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { priority, enabled, api_key } = req.body;
    const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
    const adminUser = await authService.getUserById(adminId);
    const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';

    const encryptedKey = api_key && !api_key.startsWith('********')
      ? providerConfigService.encryptKey(api_key)
      : null;

    try {
      // 1. Pre-flight check: Load original values to log previous state differences
      const { data: existing, error: fetchErr } = await supabase
        .from('api_providers')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchErr || !existing) throw new Error('Provider not found');

      // Dynamic details masking
      const maskedDetails = {
        provider_id: id,
        priority,
        enabled,
        api_key: api_key ? '[REDACTED]' : undefined,
        previous: { priority: existing.priority, enabled: existing.enabled }
      };

      // 2. Execute Database-level Transactional RPC
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

      // Mask sensitive API key in log payload
      const loggedPayload = {
        ...rpcPayload,
        p_api_key: rpcPayload.p_api_key ? '[ENCRYPTED_KEY_PRESENT]' : null
      };

      winstonLogger.info(`[Admin] Invoking admin_update_provider_rpc for provider_id: ${id} with payload: ${JSON.stringify(loggedPayload)}`);

      const rpcResponse = await supabase.rpc('admin_update_provider_rpc', rpcPayload);
      const { data: rpcData, error } = rpcResponse;

      if (error) {
        winstonLogger.error(`[Admin] RPC admin_update_provider_rpc failed for provider_id: ${id}. Error: ${error.message} (Code: ${error.code}). Response data: ${JSON.stringify(rpcData)}`);
        throw error;
      }

      winstonLogger.info(`[Admin] RPC admin_update_provider_rpc succeeded for provider_id: ${id}. Response: ${JSON.stringify(rpcData)}`);

      // 3. DB Succeeded: Flush cache
      providerConfigService.flushCache(existing.provider_name);

      res.status(200).json({ success: true, provider: { id, priority, enabled } });
    } catch (dbError: any) {
      winstonLogger.warn(`[Admin] DB update provider failed: ${dbError.message}. Using in-memory fallback.`);
      
      const existing = fallbackProviders.find(p => p.id === id);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Provider not found' });
      }

      if (priority !== undefined) existing.priority = priority;
      if (enabled !== undefined) existing.enabled = enabled;
      if (encryptedKey) existing.api_key = encryptedKey;
      existing.updated_at = new Date().toISOString();

      providerConfigService.flushCache(existing.provider_name);
      
      winstonLogger.info(`[api_provider_toggled] Telemetry logged. Provider toggled: ${existing.provider_name}`);

      res.status(200).json({ success: true, provider: { id, priority, enabled }, fallback: true });
    }
  } catch (error: any) {
    winstonLogger.error(`[ADMIN_EXCEPTION] UpdateProvider transaction failed. Error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
  }
};

export const deleteProvider = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const adminId = (req as any).user?.id || req.headers['x-user-id'] as string || 'unknown-admin';
    const adminUser = await authService.getUserById(adminId);
    const adminEmail = adminUser?.email || 'unknown-admin@trayago.in';

    try {
      // 1. Pre-flight check: Load original provider values
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

      // 2. Execute Database-level Transactional RPC (Soft delete)
      const { error } = await supabase.rpc('admin_delete_provider_rpc', {
        p_admin_id: adminId,
        p_admin_email: adminEmail,
        p_provider_id: id,
        p_ip_address: req.ip || req.headers['x-forwarded-for'] as string || null,
        p_user_agent: req.headers['user-agent'] || null,
        p_details: maskedDetails
      });

      if (error) throw error;

      // 3. DB Succeeded: Flush cache
      providerConfigService.flushCache(existing.provider_name);

      res.status(200).json({ success: true });
    } catch (dbError: any) {
      winstonLogger.warn(`[Admin] DB delete provider failed: ${dbError.message}. Using in-memory fallback.`);
      
      const existing = fallbackProviders.find(p => p.id === id);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Provider not found' });
      }

      existing.is_deleted = true;
      existing.updated_at = new Date().toISOString();
      providerConfigService.flushCache(existing.provider_name);

      res.status(200).json({ success: true, fallback: true });
    }
  } catch (error: any) {
    winstonLogger.error(`[ADMIN_EXCEPTION] DeleteProvider transaction failed. Error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Audit transaction failed. State change rolled back.' });
  }
};

