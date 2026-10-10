import { useQuery } from '@tanstack/react-query';
import type {
  CompanyDto,
  DepartmentDto,
  DocumentCategoryDto,
  EmployeeSummaryDto,
  LocationDto,
  LookupDto,
  LookupKind,
} from '@hrms/shared';
import { get } from './api';
import { useAuth } from '../auth/AuthContext';

/** Shared reference data used by many screens (cached by React Query). */

export function useCompanies() {
  const { can } = useAuth();
  return useQuery({
    queryKey: ['companies'],
    queryFn: () => get<CompanyDto[]>('/companies'),
    enabled: can('org.company.view'),
    staleTime: 60_000,
  });
}

export function useDepartments(companyId: string | null | undefined) {
  const { can } = useAuth();
  return useQuery({
    queryKey: ['departments', companyId],
    queryFn: () => get<DepartmentDto[]>(`/companies/${companyId}/departments`),
    enabled: !!companyId && can('org.department.view'),
    staleTime: 60_000,
  });
}

export function useLocations(companyId: string | null | undefined) {
  const { can } = useAuth();
  return useQuery({
    queryKey: ['locations', companyId],
    queryFn: () => get<LocationDto[]>(`/companies/${companyId}/locations`),
    enabled: !!companyId && can('org.location.view'),
    staleTime: 60_000,
  });
}

export function useLookups() {
  return useQuery({ queryKey: ['lookups'], queryFn: () => get<LookupDto[]>('/lookups'), staleTime: 60_000 });
}

export function useDocumentCategories() {
  return useQuery({
    queryKey: ['document-categories'],
    queryFn: () => get<DocumentCategoryDto[]>('/document-categories'),
    staleTime: 60_000,
  });
}

export function useEmployeeOptions(enabled = true) {
  const { can } = useAuth();
  return useQuery({
    queryKey: ['employees', 'options'],
    queryFn: () => get<EmployeeSummaryDto[]>('/employees?limit=500'),
    enabled: enabled && can('employee.profile.view'),
    staleTime: 60_000,
  });
}

/** Select options for one list kind, usable in a company (group-wide + company values). */
export function lookupOptions(
  all: LookupDto[] | undefined,
  kind: LookupKind,
  lang: string,
  companyId?: string | null,
  includeId?: string | null,
) {
  return (all ?? [])
    .filter(
      (l) =>
        l.kind === kind &&
        (l.status === 'active' || l.id === includeId) &&
        (!l.companyId || l.companyId === companyId),
    )
    .map((l) => ({ value: l.id, label: lang === 'ar' ? l.nameAr : l.nameEn }));
}

export function lookupName(all: LookupDto[] | undefined, id: string | null | undefined, lang: string): string {
  const l = all?.find((x) => x.id === id);
  return l ? (lang === 'ar' ? l.nameAr : l.nameEn) : '—';
}

export function employeeName(lang: string, e: { fullNameAr: string; fullNameEn: string }): string {
  return lang === 'ar' ? e.fullNameAr : e.fullNameEn;
}
