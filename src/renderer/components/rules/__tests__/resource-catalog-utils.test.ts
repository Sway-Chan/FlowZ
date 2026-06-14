import { resolveCatalogItemState } from '../resource-catalog-utils';

describe('resolveCatalogItemState', () => {
  describe('内置 TAB', () => {
    it('文件在 → 不可勾选、不标缺失', () => {
      expect(resolveCatalogItemState('builtin', true)).toEqual({
        selectable: false,
        missing: false,
      });
    });

    it('文件该在却没在 → 不可勾选、标缺失（真异常）', () => {
      expect(resolveCatalogItemState('builtin', false)).toEqual({
        selectable: false,
        missing: true,
      });
    });
  });

  describe('外置 TAB', () => {
    it('已下载且文件在 → 不可重复勾选、不标缺失', () => {
      expect(resolveCatalogItemState('external', true)).toEqual({
        selectable: false,
        missing: false,
      });
    });

    // 回归护栏：外置未下载/被删是常态，绝不标「文件缺失」（曾整页误标红）。
    it('未下载或文件被删 → 可勾选下载、绝不标缺失', () => {
      expect(resolveCatalogItemState('external', false)).toEqual({
        selectable: true,
        missing: false,
      });
    });
  });
});
