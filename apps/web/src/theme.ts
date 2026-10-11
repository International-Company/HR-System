import { createTheme, type MantineColorsTuple } from '@mantine/core';

// Calm corporate blue (primary #1D4ED8 at index 6), UX-01.
const brand: MantineColorsTuple = [
  '#eef4ff',
  '#dbe6ff',
  '#b5cbfd',
  '#8aaefb',
  '#6694f9',
  '#4f83f8',
  '#1d4ed8',
  '#1a44c0',
  '#163aa8',
  '#11308f',
];

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: 6,
  colors: { brand },
  fontFamily: '"Cairo Variable", system-ui, sans-serif',
  headings: { fontFamily: '"Cairo Variable", system-ui, sans-serif', fontWeight: '600' },
  defaultRadius: 'md',
  cursorType: 'pointer',
  components: {
    Button: { defaultProps: { radius: 'md' } },
    Paper: { defaultProps: { radius: 'md', withBorder: true } },
    Table: { defaultProps: { highlightOnHover: true, verticalSpacing: 'sm' } },
  },
});
