import { useEffect, useState } from 'react';
import { Badge, Combobox, Group, Text, TextInput, useCombobox } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { SearchResultDto } from '@hrms/shared';
import { get } from '../lib/api';

/** Global search in the header (SRCH-01); results are limited to the user's scope (SRCH-02). */
export function GlobalSearch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const combobox = useCombobox();
  const [value, setValue] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQ(value.trim()), 250);
    return () => clearTimeout(id);
  }, [value]);
  const results = useQuery({ queryKey: ['search', q], queryFn: () => get<SearchResultDto[]>(`/search?q=${encodeURIComponent(q)}`), enabled: q.length >= 2, staleTime: 30_000 });

  return (
    <Combobox
      store={combobox}
      onOptionSubmit={(link) => {
        combobox.closeDropdown();
        setValue('');
        void navigate(link);
      }}
      width={360}
    >
      <Combobox.Target>
        <TextInput
          w={{ base: 160, sm: 280 }}
          size="sm"
          leftSection={<IconSearch size={16} />}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          value={value}
          onChange={(e) => {
            setValue(e.currentTarget.value);
            combobox.openDropdown();
          }}
          onFocus={() => combobox.openDropdown()}
          onBlur={() => combobox.closeDropdown()}
        />
      </Combobox.Target>
      <Combobox.Dropdown hidden={q.length < 2}>
        <Combobox.Options>
          {results.data?.length === 0 && <Combobox.Empty>{t('search.none')}</Combobox.Empty>}
          {results.data?.map((r) => (
            <Combobox.Option key={`${r.kind}-${r.id}`} value={r.link}>
              <Group justify="space-between" wrap="nowrap">
                <div>
                  <Text size="sm">{r.title}</Text>
                  <Text size="xs" c="dimmed" dir="auto">
                    {r.subtitle}
                  </Text>
                </div>
                <Badge size="xs" variant="light">
                  {t(`search.kinds.${r.kind}`)}
                </Badge>
              </Group>
            </Combobox.Option>
          ))}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
