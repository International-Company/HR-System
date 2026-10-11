import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicSettings, SessionInfo } from '@hrms/shared';
import { ApiError, get, post, setCsrfToken, setUnauthorizedHandler } from '../lib/api';
import { applyLanguage } from '../i18n';
import { makeFormatter, type Formatter } from '../lib/format';

interface AuthValue {
  session: SessionInfo | null;
  settings: PublicSettings;
  fmt: Formatter;
  loading: boolean;
  can(permission: string): boolean;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const DEFAULT_SETTINGS: PublicSettings = {
  language: 'ar',
  timezone: 'UTC',
  dateFormat: 'DD/MM/YYYY',
  timeFormat: '24h',
  numerals: 'latn',
  groupName: null,
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: ['public-settings'],
    queryFn: () => get<PublicSettings>('/settings/public'),
    staleTime: 60_000,
  });
  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return await get<SessionInfo>('/auth/session');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 30_000,
    retry: false,
  });

  const settings = settingsQuery.data ?? DEFAULT_SETTINGS;
  const session = sessionQuery.data ?? null;

  useEffect(() => applyLanguage(settings.language), [settings.language]);
  useEffect(() => setCsrfToken(session?.csrfToken ?? null), [session?.csrfToken]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(['session'], null);
    });
  }, [qc]);

  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['session'] }),
      qc.invalidateQueries({ queryKey: ['public-settings'] }),
    ]);
  }, [qc]);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } finally {
      // Signal "signed out" on the existing session query first, so the screen switches to the
      // login page at once. qc.clear() would drop that query and leave the screen subscribed to
      // a removed entry (the user stayed "signed in" until a reload).
      await qc.cancelQueries();
      qc.setQueryData(['session'], null);
      setCsrfToken(null);
      // Then drop every other cached response (personal data must not survive the session).
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' && q.queryKey[0] !== 'public-settings' });
    }
  }, [qc]);

  const value = useMemo<AuthValue>(() => {
    const perms = new Set(session?.permissions ?? []);
    return {
      session,
      settings,
      fmt: makeFormatter(settings),
      loading: sessionQuery.isLoading || settingsQuery.isLoading,
      can: (p) => perms.has(p),
      refresh,
      logout,
    };
  }, [session, settings, sessionQuery.isLoading, settingsQuery.isLoading, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
