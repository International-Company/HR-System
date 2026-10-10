import { describe, expect, it } from 'vitest';
import { ar } from './ar';
import { en } from './en';

function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe('translations', () => {
  it('Arabic and English define exactly the same keys', () => {
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });
  it('no translation is empty', () => {
    const flat = (o: object): string[] =>
      Object.values(o).flatMap((v) => (typeof v === 'object' ? flat(v as object) : [String(v)]));
    expect(flat(ar).filter((s) => !s.trim())).toEqual([]);
    expect(flat(en).filter((s) => !s.trim())).toEqual([]);
  });
});
